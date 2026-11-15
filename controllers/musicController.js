const db = require("../config/db");
const cache = require("../utils/cache");
const path = require("path");
const storage = require("../services/storage");

// 预设初音未来音乐歌单（保底/默认数据，仅在 music 表缺失或为空时使用）
// 注意：统一使用 /uploads/music/* 相对路径，读取时由 toAbsoluteUrl 补全为绝对地址，
// 以保证开发环境(前端 5173 与后端 3001 跨域)与生产环境(nginx 同源)下 <audio> 都能正确加载。
const defaultPlaylist = [
  {
    id: 1,
    title: "甩葱歌 (Ievan Polkka)",
    artist: "初音ミク",
    album: "Vocaloid Classic",
    duration_sec: 147,
    duration_str: "02:27",
    cover: "",
    url: "/uploads/music/shuaicong.mp3",
    is_active: 1,
    sort_order: 1
  },
  {
    id: 2,
    title: "千本桜 (Senbonzakura)",
    artist: "初音ミク",
    album: "WhiteFlame",
    duration_sec: 244,
    duration_str: "04:04",
    cover: "",
    url: "/uploads/music/qianben.mp3",
    is_active: 1,
    sort_order: 2
  },
  {
    id: 3,
    title: "Tell Your World",
    artist: "初音ミク",
    album: "Livetune",
    duration_sec: 257,
    duration_str: "04:17",
    cover: "",
    url: "/uploads/music/tell-your-world.mp3",
    is_active: 1,
    sort_order: 3
  },
  {
    id: 4,
    title: "メルト (Melt)",
    artist: "初音ミク",
    album: "ryo (supercell)",
    duration_sec: 315,
    duration_str: "05:15",
    cover: "",
    url: "/uploads/music/melt.mp3",
    is_active: 1,
    sort_order: 4
  }
];

// 将相对资源路径补全为带协议+域名的绝对地址。
// 开发环境前端跑在 5173、音频在后端 3001，必须走绝对地址；
// 生产环境 nginx 同源，绝对地址同样可用（避免 Vite 静态 / 后端静态差异导致的 404）。
function toAbsoluteUrl(req, url) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  const base = `${req.protocol}://${req.get("host")}`;
  return url.startsWith("/") ? base + url : `${base}/${url}`;
}

// 音乐文件字段 → 显示字段：url(音频)→play_url 播放地址，cover(封面)→cover_url
const MUSIC_FIELDS = { url: "play_url", cover: "cover_url" };

// 公开接口：获取歌单（仅启用，按 sort_order 升序）
exports.getPlaylist = async (req, res) => {
  try {
    const cacheKey = "music_playlist";
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      const data = cachedData.map((s) => storage.attachUrls({ ...s }, MUSIC_FIELDS));
      return res.json({ code: 200, message: "获取歌单列表成功(缓存)", data });
    }

    const [rows] = await db.query(
      "SELECT id, title, artist, album, duration_sec, duration_str, cover, url, is_active, sort_order FROM music WHERE is_active = 1 ORDER BY sort_order ASC, id ASC"
    );
    if (rows.length > 0) {
      cache.set(cacheKey, rows, 60000);
      const data = rows.map((r) => storage.attachUrls({ ...r }, MUSIC_FIELDS));
      return res.json({ code: 200, message: "获取歌单列表成功", data });
    }

    const data = defaultPlaylist.map((s) => storage.attachUrls({ ...s }, MUSIC_FIELDS));
    return res.json({ code: 200, message: "获取预设初音歌单列表成功", data });
  } catch (error) {
    console.error("获取歌单失败:", error);
    const data = defaultPlaylist.map((s) => storage.attachUrls({ ...s }, MUSIC_FIELDS));
    return res.json({ code: 200, message: "获取预设初音歌单列表成功", data });
  }
};

// 公开接口：当前播放（sort_order 最靠前的一首）
exports.getNowPlaying = async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, title, artist, album, duration_sec, duration_str, cover, url, is_active, sort_order FROM music WHERE is_active = 1 ORDER BY sort_order ASC, id ASC LIMIT 1"
    );
    if (rows.length > 0) {
      return res.json({
        code: 200,
        message: "获取 NOW PLAYING 成功",
        data: storage.attachUrls({ ...rows[0] }, MUSIC_FIELDS),
      });
    }
    return res.json({
      code: 200,
      message: "获取 NOW PLAYING 成功",
      data: storage.attachUrls({ ...defaultPlaylist[0] }, MUSIC_FIELDS),
    });
  } catch (error) {
    return res.json({
      code: 200,
      message: "获取 NOW PLAYING 成功",
      data: storage.attachUrls({ ...defaultPlaylist[0] }, MUSIC_FIELDS),
    });
  }
};

// 管理端：获取全部曲目（含禁用）
exports.getAllMusic = async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM music ORDER BY sort_order ASC, id ASC"
    );
    const data = rows.map((r) => storage.attachUrls({ ...r }, MUSIC_FIELDS));
    res.json({ code: 200, message: "获取成功", data });
  } catch (error) {
    console.error("获取音乐列表错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 管理端：获取单条曲目
exports.getMusicById = async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await db.query("SELECT * FROM music WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ code: 404, message: "曲目不存在" });
    }
    const row = rows[0];
    res.json({
      code: 200,
      message: "获取成功",
      data: storage.attachUrls({ ...row }, MUSIC_FIELDS),
    });
  } catch (error) {
    console.error("获取音乐详情错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 管理端：新增曲目
exports.createMusic = async (req, res) => {
  const {
    title,
    artist,
    album,
    duration_sec,
    duration_str,
    cover,
    url,
    sort_order,
    is_active,
  } = req.body;

  if (!url) {
    return res.status(400).json({ code: 400, message: "音频地址不能为空" });
  }

  try {
    await db.query(
      "INSERT INTO music (title, artist, album, duration_sec, duration_str, cover, url, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        title || "",
        artist || "",
        album || "",
        Number(duration_sec) || 0,
        duration_str || "",
        cover || "",
        url,
        Number(sort_order) || 0,
        is_active !== undefined ? Number(is_active) : 1,
      ]
    );
    cache.delete("music_playlist");
    cache.delete("home_bootstrap");
    res.status(201).json({ code: 201, message: "曲目创建成功" });
  } catch (error) {
    console.error("创建曲目错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 管理端：修改曲目
exports.updateMusic = async (req, res) => {
  const { id } = req.params;
  const {
    title,
    artist,
    album,
    duration_sec,
    duration_str,
    cover,
    url,
    sort_order,
    is_active,
  } = req.body;

  try {
    const [existingRows] = await db.query("SELECT * FROM music WHERE id = ?", [id]);
    if (existingRows.length === 0) {
      return res.status(404).json({ code: 404, message: "曲目不存在" });
    }
    const cur = existingRows[0];

    await db.query(
      "UPDATE music SET title = ?, artist = ?, album = ?, duration_sec = ?, duration_str = ?, cover = ?, url = ?, sort_order = ?, is_active = ? WHERE id = ?",
      [
        title !== undefined ? title : cur.title,
        artist !== undefined ? artist : cur.artist,
        album !== undefined ? album : cur.album,
        duration_sec !== undefined ? Number(duration_sec) || 0 : cur.duration_sec,
        duration_str !== undefined ? duration_str : cur.duration_str,
        cover !== undefined ? cover : cur.cover,
        url !== undefined ? url : cur.url,
        sort_order !== undefined ? Number(sort_order) || 0 : cur.sort_order,
        is_active !== undefined ? Number(is_active) : cur.is_active,
        id,
      ]
    );
    cache.delete("music_playlist");
    cache.delete("home_bootstrap");
    res.json({ code: 200, message: "曲目更新成功" });
  } catch (error) {
    console.error("更新曲目错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 管理端：删除曲目
exports.deleteMusic = async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await db.query("DELETE FROM music WHERE id = ?", [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ code: 404, message: "曲目不存在" });
    }
    cache.delete("music_playlist");
    cache.delete("home_bootstrap");
    res.json({ code: 200, message: "曲目删除成功" });
  } catch (error) {
    console.error("删除曲目错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 管理端：上传音频文件（返回相对路径，读取时由 toAbsoluteUrl 补全）
exports.uploadMusic = async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ code: 400, message: "请选择要上传的音频文件" });
    }
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname).toLowerCase() || ".mp3";
    const filename = `${unique}${ext}`;

    // 音频原样直传，不压缩转码
    const { key, url } = await storage.put({
      buffer: file.buffer,
      dir: "music",
      filename,
      mime: file.mimetype,
    });
    res.json({ code: 200, message: "上传成功", data: { key, url } });
  } catch (error) {
    console.error("音乐上传异常:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};
