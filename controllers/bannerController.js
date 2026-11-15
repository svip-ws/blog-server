const db = require("../config/db");
const cache = require("../utils/cache");
const path = require("path");
const sharp = require("sharp");
const storage = require("../services/storage");
const { processAndStoreImage } = require("../utils/imageProcessor");

// banner 文件字段 → 显示字段：media_url(图片/视频)→media_signed_url
const BANNER_FIELDS = { media_url: "media_signed_url" };

// 0. 上传轮播媒体：图片(gif/webp校验魔数、其余压缩 webp)，视频原样直传
exports.uploadBanner = async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ code: 400, message: "请选择要上传的文件" });
    }
    const isImage = /^image\//.test(file.mimetype);
    if (isImage) {
      const { key, url } = await processAndStoreImage(file, "banner");
      return res.json({ code: 200, message: "上传成功", data: { key, url } });
    }

    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname).toLowerCase();
    const { key, url } = await storage.put({
      buffer: file.buffer,
      dir: "banner",
      filename: `${unique}${ext}`,
      mime: file.mimetype,
    });
    res.json({ code: 200, message: "上传成功", data: { key, url } });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ code: 400, message: error.message });
    }
    console.error("轮播图上传异常:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 1. 获取轮播图列表（前台公开，只返回启用的）
exports.getActiveBanners = async (req, res) => {
  try {
    const cacheKey = "active_banners";
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      const signed = cachedData.map((b) => storage.attachUrls({ ...b }, BANNER_FIELDS));
      return res.json({ code: 200, message: "获取成功(缓存)", data: signed });
    }

    const [banners] = await db.query(
      "SELECT * FROM banner WHERE status = 1 ORDER BY sort_order DESC, create_time DESC",
    );
    cache.set(cacheKey, banners, 60000); // 缓存 60s（只存原始 key）
    const signed = banners.map((b) => storage.attachUrls({ ...b }, BANNER_FIELDS));
    res.json({ code: 200, message: "获取成功", data: signed });
  } catch (error) {
    console.error("获取轮播图错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 2. 获取所有轮播图（管理端，含禁用的）
exports.getAllBanners = async (req, res) => {
  try {
    const [banners] = await db.query(
      "SELECT * FROM banner ORDER BY sort_order DESC, create_time DESC",
    );
    const signed = banners.map((b) => storage.attachUrls({ ...b }, BANNER_FIELDS));
    res.json({ code: 200, message: "获取成功", data: signed });
  } catch (error) {
    console.error("获取轮播图列表错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 3. 获取单条轮播图
exports.getBannerById = async (req, res) => {
  const { id } = req.params;
  try {
    const [banners] = await db.query("SELECT * FROM banner WHERE id = ?", [id]);
    if (banners.length === 0) {
      return res.status(404).json({ code: 404, message: "轮播图不存在" });
    }
    res.json({ code: 200, message: "获取成功", data: storage.attachUrls({ ...banners[0] }, BANNER_FIELDS) });
  } catch (error) {
    console.error("获取轮播图详情错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 4. 新增轮播图
exports.createBanner = async (req, res) => {
  const { title, subtitle, media_url, media_type, link, sort_order, status } =
    req.body;

  if (!media_url) {
    return res.status(400).json({ code: 400, message: "媒体地址不能为空" });
  }

  try {
    await db.query(
      "INSERT INTO banner (title, subtitle, media_url, media_type, link, sort_order, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        title || "",
        subtitle || "",
        media_url,
        media_type || "image",
        link || "",
        sort_order || 0,
        status !== undefined ? status : 1,
      ],
    );
    cache.clear();
    res.status(201).json({ code: 201, message: "轮播图创建成功" });
  } catch (error) {
    console.error("创建轮播图错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 5. 修改轮播图
exports.updateBanner = async (req, res) => {
  const { id } = req.params;
  const { title, subtitle, media_url, media_type, link, sort_order, status } =
    req.body;

  try {
    const [existingRows] = await db.query("SELECT * FROM banner WHERE id = ?", [id]);
    if (existingRows.length === 0) {
      return res.status(404).json({ code: 404, message: "轮播图不存在" });
    }
    const cur = existingRows[0];

    await db.query(
      "UPDATE banner SET title = ?, subtitle = ?, media_url = ?, media_type = ?, link = ?, sort_order = ?, status = ? WHERE id = ?",
      [
        title !== undefined ? title : cur.title,
        subtitle !== undefined ? subtitle : cur.subtitle,
        media_url !== undefined ? media_url : cur.media_url,
        media_type !== undefined ? media_type : (cur.media_type || "image"),
        link !== undefined ? link : cur.link,
        sort_order !== undefined ? sort_order : (cur.sort_order || 0),
        status !== undefined ? status : cur.status,
        id,
      ],
    );

    cache.clear();
    res.json({ code: 200, message: "轮播图更新成功" });
  } catch (error) {
    console.error("更新轮播图错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 6. 删除轮播图
exports.deleteBanner = async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await db.query("DELETE FROM banner WHERE id = ?", [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ code: 404, message: "轮播图不存在" });
    }
    cache.clear();
    res.json({ code: 200, message: "轮播图删除成功" });
  } catch (error) {
    console.error("删除轮播图错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};
