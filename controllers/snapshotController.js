const db = require("../config/db");
const snap = require("../services/snapshotService");

const { PRESET_CARDS, formatDate, ensureTableExists } = snap;

const viewCountBuffer = require("../utils/viewCountBuffer");

const path = require("path");
const sharp = require("sharp");
const storage = require("../services/storage");
const { getClientIp } = require("../utils/clientIp");
const { processAndStoreImage } = require("../utils/imageProcessor");

// 随拍文件字段 → 显示字段
const SNAP_FIELDS = {
  cover: "cover_url",
  original_image: "original_image_url",
  thumbnail: "thumbnail_url",
  glb_path: "glb_url",
};

/**
 * 1. 获取公开随拍卡片列表（前台，分页 + 分类 + 关键词搜索 + 排序）
 */
exports.getSnapshotList = async (req, res) => {
  try {
    await ensureTableExists();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.max(1, parseInt(req.query.pageSize) || 12);
    const category = req.query.category;
    const keyword = req.query.keyword;
    const sort = req.query.sort;
    const offset = (page - 1) * pageSize;

    let querySql = "SELECT * FROM snapshot_card WHERE is_published = 1 AND status = 1";
    let countSql = "SELECT COUNT(*) AS total FROM snapshot_card WHERE is_published = 1 AND status = 1";
    let queryParams = [];
    let countParams = [];

    if (category && category !== "全部" && category !== "undefined" && category !== "null") {
      querySql += " AND category = ?";
      countSql += " AND category = ?";
      queryParams.push(category);
      countParams.push(category);
    }

    if (keyword && typeof keyword === "string" && keyword.trim()) {
      querySql += " AND (name LIKE ? OR description LIKE ? OR card_no LIKE ?)";
      countSql += " AND (name LIKE ? OR description LIKE ? OR card_no LIKE ?)";
      const kw = `%${keyword.trim()}%`;
      queryParams.push(kw, kw, kw);
      countParams.push(kw, kw, kw);
    }

    if (sort === "newest") {
      querySql += " ORDER BY create_time DESC";
    } else {
      querySql += " ORDER BY sort_order DESC, create_time DESC";
    }

    querySql += ` LIMIT ${Number(pageSize)} OFFSET ${Number(offset)}`;

    const [countResult, listResult] = await Promise.all([
      db.query(countSql, countParams),
      db.query(querySql, queryParams),
    ]);

    const total = countResult?.[0]?.[0]?.total ?? 0;
    const rawList = listResult?.[0] || [];
    const list = rawList.map((item) => {
      const row = { ...item, create_time: formatDate(item.create_time) };
      return storage.attachUrls(row, SNAP_FIELDS);
    });

    res.json({ code: 200, message: "获取成功", data: { list, total, page, pageSize } });
  } catch (error) {
    console.error("获取随拍卡片列表数据库异常:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 2. 获取随拍卡片分类列表
 */
exports.getCategories = async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT DISTINCT category FROM snapshot_card WHERE is_published = 1 AND category IS NOT NULL ORDER BY category"
    );
    let categories = rows.map((r) => r.category).filter(Boolean);
    const defaults = ["风景", "二次元", "人物", "生活", "赛博朋克", "艺术"];
    defaults.forEach((c) => { if (!categories.includes(c)) categories.push(c); });
    categories.unshift("全部");
    res.json({ code: 200, message: "获取成功", data: categories });
  } catch (error) {
    res.json({
      code: 200, message: "获取成功",
      data: ["全部", "风景", "二次元", "人物", "生活", "赛博朋克", "艺术"],
    });
  }
};

/**
 * 3. 获取单张随拍卡片详情 (不存在返回 404，接入异步浏览量缓冲与 IP 冷却防刷)
 */
exports.getSnapshotById = async (req, res) => {
  const { id } = req.params;

  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ code: 400, message: "随拍卡片ID不合法" });
  }

  try {
    const [cards] = await db.query(
      "SELECT * FROM snapshot_card WHERE id = ? AND is_published = 1 AND status = 1",
      [id]
    );

    if (!cards || cards.length === 0) {
      return res.status(404).json({ code: 404, message: "随拍卡片不存在或已被下架" });
    }

    const clientIp = getClientIp(req);
    viewCountBuffer.recordSnapshot(id, clientIp);
    const pending = viewCountBuffer.getPendingCount("snapshot", id);

    const card = storage.attachUrls(
      {
        ...cards[0],
        view_count: (cards[0].view_count || 0) + pending,
        create_time: formatDate(cards[0].create_time)
      },
      SNAP_FIELDS
    );
    res.json({ code: 200, message: "获取成功", data: card });
  } catch (error) {
    console.error("获取随拍详情数据库异常:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 4. 卡片点赞 / 取消点赞 (服务端去重、事务行锁、源表 COUNT 重算、杜绝假数据)
 */
exports.likeSnapshot = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ code: 400, message: "随拍卡片ID不合法" });
  }

  const userId = req.user ? req.user.id : null;
  const clientIp = getClientIp(req);

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    const [cards] = await conn.query(
      "SELECT id FROM snapshot_card WHERE id = ? AND status = 1 FOR UPDATE",
      [id]
    );
    if (!cards || cards.length === 0) {
      await conn.rollback();
      return res.status(404).json({ code: 404, message: "随拍卡片不存在或已被下架" });
    }

    let existing = [];
    if (userId) {
      [existing] = await conn.query(
        "SELECT id FROM snapshot_like WHERE snapshot_id = ? AND user_id = ? FOR UPDATE",
        [id, userId]
      );
    } else {
      [existing] = await conn.query(
        "SELECT id FROM snapshot_like WHERE snapshot_id = ? AND ip = ? FOR UPDATE",
        [id, clientIp]
      );
    }

    let liked = false;
    if (existing && existing.length > 0) {
      if (userId) {
        await conn.query(
          "DELETE FROM snapshot_like WHERE snapshot_id = ? AND user_id = ?",
          [id, userId]
        );
      } else {
        await conn.query(
          "DELETE FROM snapshot_like WHERE snapshot_id = ? AND ip = ?",
          [id, clientIp]
        );
      }
      liked = false;
    } else {
      await conn.query(
        "INSERT INTO snapshot_like (snapshot_id, user_id, ip) VALUES (?, ?, ?)",
        [id, userId, clientIp]
      );
      liked = true;
    }

    const [countRows] = await conn.query(
      "SELECT COUNT(*) AS cnt FROM snapshot_like WHERE snapshot_id = ?",
      [id]
    );
    const like_count = countRows[0].cnt;
    await conn.query(
      "UPDATE snapshot_card SET like_count = ? WHERE id = ?",
      [like_count, id]
    );

    await conn.commit();
    res.json({
      code: 200,
      message: liked ? "点赞成功" : "取消点赞",
      data: { liked, like_count }
    });
  } catch (error) {
    if (conn) {
      try { await conn.rollback(); } catch (_) { }
    }
    console.error("随拍点赞异常:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  } finally {
    if (conn) conn.release();
  }
};

// ==================== 管理端 ====================

/**
 * 5. 管理端：获取全量卡片（包含草稿、生成中、生成失败状态）
 */
exports.getAllSnapshots = async (req, res) => {
  try {
    await ensureTableExists();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.max(1, parseInt(req.query.pageSize) || 10);
    const keyword = req.query.keyword || req.query.name;
    const is_published = req.query.is_published;
    const offset = (page - 1) * pageSize;

    let querySql = "SELECT * FROM snapshot_card WHERE 1 = 1";
    let countSql = "SELECT COUNT(*) AS total FROM snapshot_card WHERE 1 = 1";
    let queryParams = [];
    let countParams = [];

    if (keyword && typeof keyword === "string" && keyword.trim()) {
      querySql += " AND (name LIKE ? OR card_no LIKE ? OR category LIKE ?)";
      countSql += " AND (name LIKE ? OR card_no LIKE ? OR category LIKE ?)";
      const kw = `%${keyword.trim()}%`;
      queryParams.push(kw, kw, kw);
      countParams.push(kw, kw, kw);
    }

    if (
      is_published !== undefined && is_published !== "" &&
      is_published !== null && is_published !== "undefined" && is_published !== "null"
    ) {
      querySql += " AND is_published = ?";
      countSql += " AND is_published = ?";
      queryParams.push(Number(is_published));
      countParams.push(Number(is_published));
    }

    querySql += ` ORDER BY sort_order DESC, create_time DESC LIMIT ${Number(pageSize)} OFFSET ${Number(offset)}`;

    const [countResult, listResult] = await Promise.all([
      db.query(countSql, countParams),
      db.query(querySql, queryParams),
    ]);

    const total = countResult?.[0]?.[0]?.total ?? PRESET_CARDS.length;
    const rawList = listResult?.[0] || PRESET_CARDS;
    const list = rawList.map((item) => {
      const row = { ...item, create_time: formatDate(item.create_time) };
      return storage.attachUrls(row, SNAP_FIELDS);
    });

    res.json({ code: 200, message: "获取成功", data: { list, total, page, pageSize } });
  } catch (error) {
    console.error("管理端获取卡片异常，降级返回保底数据:", error.message);
    res.json({
      code: 200, message: "获取成功 (保底)",
      data: { list: PRESET_CARDS, total: PRESET_CARDS.length, page: 1, pageSize: 10 },
    });
  }
};

/**
 * 6. 管理端：新增随拍 3D 闪卡
 */
exports.createSnapshot = async (req, res) => {
  const {
    name, card_no, category, style_preset, description,
    cover, images, parallax_intensity, is_published, sort_order,
  } = req.body;

  if (!name) {
    return res.status(400).json({ code: 400, message: "卡片名称不能为空" });
  }

  // 上传文件：内存 buffer → 魔数校验/转 webp → 统一存储；或使用手填 URL
  let originalImgPath = cover || "";
  if (req.file) {
    try {
      const stored = await processAndStoreImage(req.file, "snap/originals");
      originalImgPath = stored.key;
    } catch (e) {
      if (e.status === 400) {
        return res.status(400).json({ code: 400, message: e.message });
      }
      console.error("随拍封面上传失败:", e.message);
      return res.status(500).json({ code: 500, message: "封面上传失败" });
    }
  } else if (cover) {
    originalImgPath = cover;
  }

  const generatedNo = card_no || `No.${String(Math.floor(Math.random() * 900 + 100))}`;

  const cardConfig = {
    cardNo: generatedNo, title: name, category: category || "风景",
    stylePreset: style_preset || "standard", description: description || "",
    parallaxIntensity: parallax_intensity || 1.5,
  };

  try {
    await ensureTableExists();
    const [result] = await db.query(
      `INSERT INTO snapshot_card (name, card_no, category, style_preset, description, cover, original_image, images, parallax_intensity, is_published, status, sort_order, config_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name, generatedNo, category || "风景", style_preset || "standard", description || "",
        originalImgPath, originalImgPath, images || "[]", parallax_intensity || 1.5,
        is_published !== undefined ? Number(is_published) : 1,
        1, // status = 1 (直接完成)
        sort_order || 0, JSON.stringify(cardConfig),
      ]
    );

    res.status(200).json({
      code: 200, message: "卡片创建成功",
      data: { id: result.insertId, status: 1, card_no: generatedNo, config: cardConfig },
    });
  } catch (error) {
    console.error("创建随拍卡片错误:", error);
    res.status(500).json({ code: 500, message: "创建失败，请稍后重试" });
  }
};

/**
 * 7. 查询卡片流水线生成进度与状态
 * GET /api/snapshot/:id/status
 */
exports.getPipelineStatus = async (req, res) => {
  const { id } = req.params;

  // id 只能是数字自增主键，拒绝路径穿越
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ code: 400, message: "无效的卡片 ID" });
  }

  try {
    const progressData = snap.readPipelineProgress(id);
    if (progressData) {
      return res.json({ code: 200, message: "获取成功", data: progressData });
    }

    const [rows] = await db.query(
      "SELECT id, status, is_published, error_log FROM snapshot_card WHERE id = ?", [id]
    );
    if (rows.length > 0) {
      const card = rows[0];
      const statusMap = {
        0: { progress: 100, message: "草稿" },
        1: { progress: 100, message: "生成完成!" },
        2: { progress: 20, message: "正在生成分层图像..." },
        3: { progress: 0, message: card.error_log || "生成失败" }
      };
      const info = statusMap[card.status] || { progress: 0, message: "未知状态" };
      return res.json({
        code: 200, message: "获取成功",
        data: {
          id: card.id, status: card.status, progress: info.progress,
          message: info.message, error_log: card.error_log
        }
      });
    }

    res.status(404).json({ code: 404, message: "未找到该卡片记录" });
  } catch (error) {
    console.error("获取卡片流水线状态出错:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 8. 重新触发流水线生成
 * POST /api/snapshot/:id/retry
 */
exports.retryPipeline = async (req, res) => {
  const { id } = req.params;

  try {
    await ensureTableExists();
    const [rows] = await db.query("SELECT * FROM snapshot_card WHERE id = ?", [id]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ code: 404, message: "未找到卡片记录" });
    }

    const card = rows[0];
    await db.query("UPDATE snapshot_card SET status = 2, error_log = NULL WHERE id = ?", [id]);

    const origImg = card.original_image || card.cover;
    const diskPath = snap.resolveDiskPath(origImg);

    snap.triggerCardPipeline(card.id, card, diskPath)
      .catch((e) => console.error(`[快照 ${card.id}] 补处理失败:`, e?.message || e));

    res.json({
      code: 200, message: "已重新触发 3D 闪卡生成流水线",
      data: { id: card.id, status: 2 }
    });
  } catch (error) {
    console.error("重试卡片流水线错误:", error);
    res.status(500).json({ code: 500, message: "重试失败，请稍后重试" });
  }
};

/**
 * 9. 管理端：修改随拍卡片
 */
exports.updateSnapshot = async (req, res) => {
  const { id } = req.params;
  const {
    name, card_no, category, style_preset, description,
    cover, images, parallax_intensity, is_published, sort_order,
  } = req.body;

  try {
    await ensureTableExists();
    const [existingRows] = await db.query("SELECT * FROM snapshot_card WHERE id = ?", [id]);
    if (existingRows.length === 0) {
      return res.status(404).json({ code: 404, message: "卡片不存在" });
    }
    const existing = existingRows[0];

    const nextName = name !== undefined ? name : existing.name;
    const nextCardNo = card_no !== undefined ? card_no : (existing.card_no || `No.${id}`);
    const nextCategory = category !== undefined ? category : (existing.category || "风景");
    const nextStylePreset = style_preset !== undefined ? style_preset : (existing.style_preset || "standard");
    const nextDesc = description !== undefined ? description : (existing.description || "");
    const nextParallax = parallax_intensity !== undefined ? parallax_intensity : (existing.parallax_intensity || 1.5);
    const nextPublished = is_published !== undefined ? Number(is_published) : existing.is_published;
    const nextSort = sort_order !== undefined ? sort_order : (existing.sort_order || 0);

    const cardConfig = {
      cardNo: nextCardNo, title: nextName, category: nextCategory,
      stylePreset: nextStylePreset, description: nextDesc,
      parallaxIntensity: nextParallax,
    };

    let updateSql = `UPDATE snapshot_card SET name=?, card_no=?, category=?, style_preset=?, description=?, parallax_intensity=?, is_published=?, sort_order=?, config_json=?`;
    let params = [
      nextName, nextCardNo, nextCategory, nextStylePreset, nextDesc,
      nextParallax, nextPublished, nextSort, JSON.stringify(cardConfig),
    ];

    if (cover) {
      updateSql += `, cover=?`;
      params.push(cover);
    }

    updateSql += ` WHERE id=?`;
    params.push(id);

    await db.query(updateSql, params);
    res.json({ code: 200, message: "卡片更新成功" });
  } catch (error) {
    console.error("更新卡片错误:", error);
    res.status(500).json({ code: 500, message: "更新失败，请稍后重试" });
  }
};

/**
 * 10. 管理端：删除随拍卡片
 */
exports.deleteSnapshot = async (req, res) => {
  const { id } = req.params;
  try {
    await ensureTableExists();
    await db.query("DELETE FROM snapshot_card WHERE id = ?", [id]);
    res.json({ code: 200, message: "卡片删除成功" });
  } catch (error) {
    console.error("删除卡片错误:", error);
    res.status(500).json({ code: 500, message: "删除失败，请稍后重试" });
  }
};
