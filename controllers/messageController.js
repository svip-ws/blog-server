const db = require("../config/db");
const { cleanPlainText } = require("../utils/sanitizeHtml");
const storage = require("../services/storage");
const { findBlockedWord } = require("../utils/sensitiveWords");
const XLSX = require("xlsx");
const { getClientIp } = require("../utils/clientIp");

function escapeExcelCell(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

// 审核模式开关：默认关闭（先发后审，发言即时可见）；开启后新留言进入待审核(status=2)
const REQUIRE_REVIEW = String(process.env.MESSAGE_REQUIRE_REVIEW || "").toLowerCase() === "true";

const DEFAULT_AVATAR = "https://cube.elemecdn.com/3/7c/3ea6beec64369c2642b92c6726f1epng.png";

// 仅允许 http(s)、协议相对(//)或站内绝对路径(/)，拦截 javascript:/data: 等危险协议并限制长度
function safeMediaUrl(u) {
  if (!u || typeof u !== "string") return "";
  const v = u.trim().slice(0, 500);
  if (/^(https?:)?\/\//i.test(v) || v.startsWith("/")) return v;
  return "";
}

// 统一成功响应
function ok(res, message, data) {
  return res.json({ code: 200, message, data });
}

// 获取当前登录用户 ID（兼容可选鉴权）
function currentUserId(req) {
  return req.user ? req.user.id : null;
}

/**
 * 1. 获取展示中的留言列表（含回复）
 * GET /api/message/active
 */
exports.getActiveMessages = async (req, res) => {
  try {
    const [messages] = await db.query(
      `SELECT id, nickname, content, avatar, image_url, likes, is_featured, user_id,
              create_time, update_time
       FROM message_wall
       WHERE status = 1
       ORDER BY is_featured DESC, create_time DESC
       LIMIT 200`
    );

    const [replies] = await db.query(
      `SELECT id, message_id, nickname, content, user_id, create_time
       FROM message_reply
       WHERE message_id IN (?)
       ORDER BY create_time ASC`,
      [messages.length ? messages.map((m) => m.id) : [0]]
    );

    const replyMap = {};
    replies.forEach((r) => {
      if (!replyMap[r.message_id]) replyMap[r.message_id] = [];
      replyMap[r.message_id].push({
        id: r.id,
        nickname: r.nickname,
        content: r.content,
        user_id: r.user_id,
        created_at: r.create_time,
      });
    });

    const result = messages.map((m) => ({
      id: m.id,
      nickname: m.nickname,
      content: m.content,
      avatar: storage.sign(m.avatar) || DEFAULT_AVATAR,
      image_url: storage.sign(m.image_url) || "",
      likes: m.likes,
      is_featured: !!m.is_featured,
      isLiked: false,
      user_id: m.user_id,
      created_at: m.create_time,
      updated_at: m.update_time,
      replies: replyMap[m.id] || [],
    }));

    ok(res, "获取留言成功", result);
  } catch (error) {
    console.error("[message] 获取留言列表错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 2. 发表留言
 * POST /api/message
 * body: { nickname, content, image_url }
 */
exports.createMessage = async (req, res) => {
  const { nickname, content, image_url } = req.body;

  const safeContent = cleanPlainText(content).trim().slice(0, 1000);
  if (!safeContent) {
    return res.status(400).json({ code: 400, message: "留言内容不能为空或包含非法字符" });
  }
  if (findBlockedWord(safeContent)) {
    return res.status(400).json({ code: 400, message: "留言包含不适合发布的内容" });
  }

  const safeNickname = (nickname && nickname.trim())
    ? cleanPlainText(nickname).trim().slice(0, 64) || "初音骑士39号"
    : "初音骑士39号";
  // 留言附图：当前前端无上传入口，仅允许外链（历史字段）
  const safeImageUrl = safeMediaUrl(image_url);
  const user_id = currentUserId(req);

  // 头像：登录用户以后端 user.avatar（key）为准，防止前端伪造；游客用默认头像
  let finalAvatar = DEFAULT_AVATAR;
  if (user_id) {
    try {
      const [urows] = await db.query("SELECT avatar FROM user WHERE id = ?", [user_id]);
      if (urows.length && urows[0].avatar) finalAvatar = urows[0].avatar;
    } catch (e) { }
  }

  try {
    const [result] = await db.query(
      `INSERT INTO message_wall (nickname, content, avatar, image_url, user_id, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [safeNickname, safeContent, finalAvatar, safeImageUrl, user_id, REQUIRE_REVIEW ? 2 : 1]
    );

    const newMessage = {
      id: result.insertId,
      nickname: safeNickname,
      content: safeContent,
      avatar: storage.sign(finalAvatar) || DEFAULT_AVATAR,
      image_url: storage.sign(safeImageUrl),
      likes: 0,
      is_featured: false,
      isLiked: false,
      status: REQUIRE_REVIEW ? 2 : 1,
      user_id,
      created_at: new Date(),
      replies: [],
    };

    res.status(201).json({
      code: 201,
      message: REQUIRE_REVIEW ? "留言已提交，审核通过后将展示" : "留言发表成功",
      data: newMessage,
    });
  } catch (error) {
    console.error("[message] 发表留言错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 3. 点赞留言 / 取消点赞 (服务端去重、事务行锁、源表 COUNT 重算)
 * POST /api/message/:id/like
 */
exports.likeMessage = async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ code: 400, message: "留言ID不合法" });
  }

  const userId = currentUserId(req);
  const clientIp = getClientIp(req);

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    const [messages] = await conn.query(
      "SELECT id FROM message_wall WHERE id = ? AND status = 1 FOR UPDATE",
      [id]
    );
    if (!messages || messages.length === 0) {
      await conn.rollback();
      return res.status(404).json({ code: 404, message: "留言不存在或已下架" });
    }

    let existing = [];
    if (userId) {
      [existing] = await conn.query(
        "SELECT id FROM message_like WHERE message_id = ? AND user_id = ? FOR UPDATE",
        [id, userId]
      );
    } else {
      [existing] = await conn.query(
        "SELECT id FROM message_like WHERE message_id = ? AND ip = ? FOR UPDATE",
        [id, clientIp]
      );
    }

    let liked = false;
    if (existing && existing.length > 0) {
      if (userId) {
        await conn.query(
          "DELETE FROM message_like WHERE message_id = ? AND user_id = ?",
          [id, userId]
        );
      } else {
        await conn.query(
          "DELETE FROM message_like WHERE message_id = ? AND ip = ?",
          [id, clientIp]
        );
      }
      liked = false;
    } else {
      await conn.query(
        "INSERT INTO message_like (message_id, user_id, ip) VALUES (?, ?, ?)",
        [id, userId, clientIp]
      );
      liked = true;
    }

    const [countRows] = await conn.query(
      "SELECT COUNT(*) AS cnt FROM message_like WHERE message_id = ?",
      [id]
    );
    const likes = countRows[0].cnt;
    await conn.query(
      "UPDATE message_wall SET likes = ? WHERE id = ?",
      [likes, id]
    );

    await conn.commit();
    ok(res, liked ? "点赞成功" : "取消点赞", { liked, likes });
  } catch (error) {
    if (conn) {
      try { await conn.rollback(); } catch (_) { }
    }
    console.error("[message] 点赞留言错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  } finally {
    if (conn) conn.release();
  }
};

/**
 * 4. 回复留言
 * POST /api/message/:id/reply
 * body: { nickname, content }
 */
exports.replyMessage = async (req, res) => {
  const { id } = req.params;
  const { nickname, content } = req.body;

  const safeContent = cleanPlainText(content).trim().slice(0, 500);
  if (!safeContent) {
    return res.status(400).json({ code: 400, message: "回复内容不能为空或包含非法字符" });
  }
  if (findBlockedWord(safeContent)) {
    return res.status(400).json({ code: 400, message: "回复包含不适合发布的内容" });
  }

  const safeNickname = (nickname && nickname.trim())
    ? cleanPlainText(nickname).trim().slice(0, 64) || "初音骑士"
    : "初音骑士";
  const user_id = currentUserId(req);

  try {
    const [messages] = await db.query(
      "SELECT id FROM message_wall WHERE id = ? AND status = 1",
      [id]
    );
    if (messages.length === 0) {
      return res.status(404).json({ code: 404, message: "留言不存在或已下架" });
    }

    const [result] = await db.query(
      `INSERT INTO message_reply (message_id, nickname, content, user_id)
       VALUES (?, ?, ?, ?)`,
      [id, safeNickname, safeContent, user_id]
    );

    const newReply = {
      id: result.insertId,
      nickname: safeNickname,
      content: safeContent,
      user_id,
      created_at: new Date(),
    };

    res.status(201).json({ code: 201, message: "回复成功", data: newReply });
  } catch (error) {
    console.error("[message] 回复留言错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * 5. 获取用户点赞状态（支持登录用户及游客）
 * GET /api/message/liked
 */
exports.getLikedStatus = async (req, res) => {
  try {
    const userId = currentUserId(req);
    const clientIp = getClientIp(req);
    let rows = [];
    if (userId) {
      [rows] = await db.query(
        "SELECT message_id FROM message_like WHERE user_id = ?",
        [userId]
      );
    } else {
      [rows] = await db.query(
        "SELECT message_id FROM message_like WHERE ip = ?",
        [clientIp]
      );
    }
    ok(res, "获取成功", { likedIds: rows.map((r) => r.message_id) });
  } catch (error) {
    console.error("[message] 获取点赞状态错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

/**
 * ================= 管理端接口 =================
 */

// 获取留言列表（支持分页、检索）
exports.getAdminMessageList = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;

    let whereClause = "1=1";
    let queryParams = [];

    if (req.query.keyword) {
      whereClause += " AND (nickname LIKE ? OR content LIKE ?)";
      const keywordStr = `%${req.query.keyword}%`;
      queryParams.push(keywordStr, keywordStr);
    }

    if (req.query.status !== undefined && req.query.status !== "") {
      whereClause += " AND status = ?";
      queryParams.push(parseInt(req.query.status));
    }

    if (req.query.startDate) {
      whereClause += " AND create_time >= ?";
      queryParams.push(`${req.query.startDate} 00:00:00`);
    }
    if (req.query.endDate) {
      whereClause += " AND create_time <= ?";
      queryParams.push(`${req.query.endDate} 23:59:59`);
    }

    const [totalRows] = await db.query(
      `SELECT COUNT(*) as total FROM message_wall WHERE ${whereClause}`,
      queryParams
    );
    const total = totalRows[0].total;

    const [rows] = await db.query(
      `SELECT * FROM message_wall WHERE ${whereClause} ORDER BY create_time DESC LIMIT ? OFFSET ?`,
      [...queryParams, limit, offset]
    );

    // 管理端同样要签名：库里 avatar/image_url 存的是存储 key，local 驱动下需补 /uploads 前缀才能访问
    const list = rows.map((row) => ({
      ...row,
      avatar_url: storage.sign(row.avatar) || DEFAULT_AVATAR,
      image_display_url: row.image_url ? storage.sign(row.image_url) : "",
    }));

    ok(res, "获取留言列表成功", {
      list,
      total,
      page,
      limit
    });
  } catch (error) {
    console.error("[message] 获取留言列表失败:", error);
    res.status(500).json({ code: 500, message: "获取失败" });
  }
};

// 更新留言状态 (包括 status 审核状态, is_featured 精华状态)
exports.updateAdminMessageStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, is_featured } = req.body;

    let updates = [];
    let params = [];

    if (status !== undefined) {
      const normalizedStatus = Number(status);
      if (![0, 1, 2].includes(normalizedStatus)) {
        return res.status(400).json({ code: 400, message: "status 只能是 0(下架)、1(展示)、2(待审核)" });
      }
      updates.push("status = ?");
      params.push(normalizedStatus);
    }
    if (is_featured !== undefined) {
      const normalizedFeatured = is_featured === true || Number(is_featured) === 1 ? 1 : 0;
      updates.push("is_featured = ?");
      params.push(normalizedFeatured);
    }

    if (updates.length === 0) {
      return res.status(400).json({ code: 400, message: "无更新字段" });
    }

    params.push(id);
    await db.query(`UPDATE message_wall SET ${updates.join(', ')} WHERE id = ?`, params);
    ok(res, "更新成功");
  } catch (error) {
    console.error("[message] 更新状态失败:", error);
    res.status(500).json({ code: 500, message: "更新失败" });
  }
};

// 删除留言 (连同子回复、点赞关系一起删除，事务保证一致性)
exports.deleteAdminMessage = async (req, res) => {
  const { id } = req.params;
  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    // 点赞表没有外键，必须显式清理，否则留下孤儿记录
    await conn.query("DELETE FROM message_like WHERE message_id = ?", [id]);
    await conn.query("DELETE FROM message_reply WHERE message_id = ?", [id]);
    const [del] = await conn.query("DELETE FROM message_wall WHERE id = ?", [id]);

    if (!del.affectedRows) {
      await conn.rollback();
      return res.status(404).json({ code: 404, message: "留言不存在" });
    }

    await conn.commit();
    ok(res, "删除成功");
  } catch (error) {
    if (conn) {
      try { await conn.rollback(); } catch (_) { }
    }
    console.error("[message] 删除失败:", error);
    res.status(500).json({ code: 500, message: "删除失败" });
  } finally {
    if (conn) conn.release();
  }
};

/**
 * ================= 回复管理（管理端）=================
 */

// 获取某条留言下的全部回复
exports.getAdminReplies = async (req, res) => {
  const messageId = parseInt(req.params.messageId, 10);
  if (!messageId) return res.status(400).json({ code: 400, message: "留言ID不合法" });
  try {
    const [rows] = await db.query(
      `SELECT id, message_id, nickname, content, user_id, create_time
       FROM message_reply WHERE message_id = ? ORDER BY create_time ASC`,
      [messageId]
    );
    ok(res, "获取回复成功", rows);
  } catch (error) {
    console.error("[message] 获取回复失败:", error);
    res.status(500).json({ code: 500, message: "获取回复失败" });
  }
};

// 管理员回复留言（写入 message_reply，昵称固定为「站长」）
exports.adminReplyMessage = async (req, res) => {
  const messageId = parseInt(req.params.messageId, 10);
  if (!messageId) return res.status(400).json({ code: 400, message: "留言ID不合法" });

  const safeContent = cleanPlainText(req.body && req.body.content).trim().slice(0, 500);
  if (!safeContent) return res.status(400).json({ code: 400, message: "回复内容不能为空" });
  if (findBlockedWord(safeContent)) {
    return res.status(400).json({ code: 400, message: "回复包含不适合发布的内容" });
  }

  try {
    const [messages] = await db.query(
      "SELECT id FROM message_wall WHERE id = ? AND status = 1",
      [messageId]
    );
    if (!messages.length) {
      return res.status(404).json({ code: 404, message: "留言不存在或已下架" });
    }

    const [result] = await db.query(
      `INSERT INTO message_reply (message_id, nickname, content, user_id)
       VALUES (?, ?, ?, ?)`,
      [messageId, "站长", safeContent, currentUserId(req)]
    );

    res.status(201).json({
      code: 201,
      message: "回复成功",
      data: {
        id: result.insertId,
        message_id: messageId,
        nickname: "站长",
        content: safeContent,
        created_at: new Date(),
      },
    });
  } catch (error) {
    console.error("[message] 管理员回复失败:", error);
    res.status(500).json({ code: 500, message: "回复失败" });
  }
};

// 删除单条回复
exports.deleteAdminReply = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ code: 400, message: "回复ID不合法" });
  try {
    const [result] = await db.query("DELETE FROM message_reply WHERE id = ?", [id]);
    if (!result.affectedRows) {
      return res.status(404).json({ code: 404, message: "回复不存在" });
    }
    ok(res, "回复已删除");
  } catch (error) {
    console.error("[message] 删除回复失败:", error);
    res.status(500).json({ code: 500, message: "删除回复失败" });
  }
};

/**
 * 用户删除自己发表的留言（仅登录用户，且只能删自己的）
 */
exports.deleteOwnMessage = async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) {
    return res.status(401).json({ code: 401, message: "请先登录后再删除留言" });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ code: 400, message: "留言ID不合法" });

  let conn;
  try {
    const [rows] = await db.query("SELECT user_id FROM message_wall WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ code: 404, message: "留言不存在" });
    }
    if (rows[0].user_id !== userId) {
      return res.status(403).json({ code: 403, message: "只能删除自己发表的留言" });
    }

    conn = await db.getConnection();
    await conn.beginTransaction();
    await conn.query("DELETE FROM message_like WHERE message_id = ?", [id]);
    await conn.query("DELETE FROM message_reply WHERE message_id = ?", [id]);
    await conn.query("DELETE FROM message_wall WHERE id = ?", [id]);
    await conn.commit();
    ok(res, "留言已删除");
  } catch (error) {
    if (conn) {
      try { await conn.rollback(); } catch (_) { }
    }
    console.error("[message] 删除自己的留言失败:", error);
    res.status(500).json({ code: 500, message: "删除失败" });
  } finally {
    if (conn) conn.release();
  }
};

/**
 * 批量操作：delete / hide / show / feature / unfeature
 */
exports.batchAdminMessages = async (req, res) => {
  const rawIds = req.body && req.body.ids;
  const ids = Array.isArray(rawIds)
    ? rawIds.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  const action = req.body && req.body.action;

  if (!ids.length) return res.status(400).json({ code: 400, message: "请先选择要操作的留言" });

  const ACTIONS = {
    delete: null,
    hide: ["status", 0],
    show: ["status", 1],
    feature: ["is_featured", 1],
    unfeature: ["is_featured", 0],
  };
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
    return res.status(400).json({ code: 400, message: "不支持的批量操作" });
  }

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    let affected = 0;
    if (action === "delete") {
      await conn.query("DELETE FROM message_like WHERE message_id IN (?)", [ids]);
      await conn.query("DELETE FROM message_reply WHERE message_id IN (?)", [ids]);
      const [del] = await conn.query("DELETE FROM message_wall WHERE id IN (?)", [ids]);
      affected = del.affectedRows;
    } else {
      const [field, value] = ACTIONS[action];
      const [upd] = await conn.query(
        `UPDATE message_wall SET ${field} = ? WHERE id IN (?)`,
        [value, ids]
      );
      affected = upd.affectedRows;
    }

    await conn.commit();
    ok(res, `已处理 ${affected} 条留言`, { affected });
  } catch (error) {
    if (conn) {
      try { await conn.rollback(); } catch (_) { }
    }
    console.error("[message] 批量操作失败:", error);
    res.status(500).json({ code: 500, message: "批量操作失败" });
  } finally {
    if (conn) conn.release();
  }
};

/**
 * 导出留言为 Excel（沿用列表的筛选条件，最多 5000 条）
 */
exports.exportAdminMessages = async (req, res) => {
  try {
    let whereClause = "1=1";
    const queryParams = [];

    if (req.query.keyword) {
      whereClause += " AND (nickname LIKE ? OR content LIKE ?)";
      const keywordStr = `%${req.query.keyword}%`;
      queryParams.push(keywordStr, keywordStr);
    }
    if (req.query.status !== undefined && req.query.status !== "") {
      whereClause += " AND status = ?";
      queryParams.push(parseInt(req.query.status));
    }
    if (req.query.startDate) {
      whereClause += " AND create_time >= ?";
      queryParams.push(`${req.query.startDate} 00:00:00`);
    }
    if (req.query.endDate) {
      whereClause += " AND create_time <= ?";
      queryParams.push(`${req.query.endDate} 23:59:59`);
    }

    const [rows] = await db.query(
      `SELECT id, nickname, content, likes, status, is_featured, create_time
       FROM message_wall WHERE ${whereClause} ORDER BY create_time DESC LIMIT 5000`,
      queryParams
    );

    const STATUS_TEXT = { 0: "已下架", 1: "展示中", 2: "待审核" };
    const sheetRows = rows.map((r) => ({
      ID: r.id,
      昵称: escapeExcelCell(r.nickname),
      留言内容: escapeExcelCell(r.content),
      点赞数: r.likes,
      状态: STATUS_TEXT[r.status] || r.status,
      精选: r.is_featured ? "是" : "否",
      创建时间: r.create_time ? new Date(r.create_time).toLocaleString() : "",
    }));

    const worksheet = XLSX.utils.json_to_sheet(sheetRows);
    worksheet["!cols"] = [
      { wch: 8 }, { wch: 16 }, { wch: 60 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 20 },
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "留言");

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const filename = `messages_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    console.error("[message] 导出失败:", error);
    res.status(500).json({ code: 500, message: "导出失败" });
  }
};

