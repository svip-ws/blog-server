const db = require("../config/db");
const cache = require("../utils/cache");

// 公开站点统计：文章/分类/标签/评论总数 + 累计访问量
exports.getSummary = async (req, res) => {
  try {
    const cacheKey = "site_stats_summary";
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      return res.json({
        code: 200,
        message: "获取成功(缓存)",
        data: cachedData,
      });
    }

    const [
      [articleAggRows],
      [categoryRows],
      [tagRows],
      [commentRows],
    ] = await Promise.all([
      db.query("SELECT COUNT(CASE WHEN status = 1 THEN 1 END) AS cnt, COALESCE(SUM(view_count), 0) AS total FROM article"),
      db.query("SELECT COUNT(*) AS cnt FROM category"),
      db.query("SELECT COUNT(*) AS cnt FROM tag"),
      db.query("SELECT COUNT(*) AS cnt FROM comment"),
    ]);
    const articleRows = [{ cnt: articleAggRows[0]?.cnt || 0 }];
    const viewRows = [{ total: articleAggRows[0]?.total || 0 }];

    const data = {
      articles: articleRows[0].cnt,
      categories: categoryRows[0].cnt,
      tags: tagRows[0].cnt,
      comments: commentRows[0].cnt,
      totalViews: Number(viewRows[0].total),
    };

    cache.set(cacheKey, data, 15000); // 缓存 15 秒

    res.json({
      code: 200,
      message: "获取成功",
      data,
    });
  } catch (error) {
    console.error("获取站点统计错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};


const bootstrapStorage = require("../services/storage");
const bootstrapCategoryService = require("../services/categoryService");
const bootstrapArticleService = require("../services/articleService");
const bootstrapDb = require("../config/db");
const bootstrapCache = require("../utils/cache");

const BOOTSTRAP_DEFAULT_AVATAR = "https://cube.elemecdn.com/3/7c/3ea6beec64369c2642b92c6726f1epng.png";
const BOOTSTRAP_DEFAULT_PLAYLIST = [
  { id: 1, title: "甩葱歌 (Ievan Polkka)", artist: "初音ミク", album: "Vocaloid Classic", duration_sec: 147, duration_str: "02:27", cover: "", url: "/uploads/music/shuaicong.mp3", is_active: 1, sort_order: 1 },
  { id: 2, title: "千本桜 (Senbonzakura)", artist: "初音ミク", album: "WhiteFlame", duration_sec: 244, duration_str: "04:04", cover: "", url: "/uploads/music/qianben.mp3", is_active: 1, sort_order: 2 },
  { id: 3, title: "Tell Your World", artist: "初音ミク", album: "Livetune", duration_sec: 257, duration_str: "04:17", cover: "", url: "/uploads/music/tell-your-world.mp3", is_active: 1, sort_order: 3 },
  { id: 4, title: "メルト (Melt)", artist: "初音ミク", album: "ryo (supercell)", duration_sec: 315, duration_str: "05:15", cover: "", url: "/uploads/music/melt.mp3", is_active: 1, sort_order: 4 },
];

// 首页单次往返聚合接口：将首屏 9 个公开接口合并为 1 次 HTTP 往返，消除浏览器 6 连接排队瀑布流
exports.getHomeBootstrap = async (req, res) => {
  try {
    const cacheKey = "home_bootstrap";
    let raw = bootstrapCache.get(cacheKey);

    const [categoriesRes, recommendRes, hotRes, latestRes] = await Promise.all([
      bootstrapCategoryService.getAllCategories(),
      bootstrapArticleService.getRecommendArticles(5),
      bootstrapArticleService.getHotArticles(8),
      bootstrapArticleService.getArticleList({ page: 1, pageSize: 6, sort: "latest" }),
    ]);

    if (!raw) {
      const [
        [banners],
        [aggRows],
        [tags],
        [comments],
        [playlistRows],
      ] = await Promise.all([
        bootstrapDb.query("SELECT * FROM banner WHERE status = 1 ORDER BY sort_order DESC, create_time DESC"),
        bootstrapDb.query(`
          SELECT
            (SELECT COUNT(*) FROM article WHERE status = 1) AS articles,
            (SELECT COUNT(*) FROM category) AS categories,
            (SELECT COUNT(*) FROM tag) AS tags,
            (SELECT COUNT(*) FROM comment) AS comments,
            (SELECT COALESCE(SUM(view_count), 0) FROM article) AS totalViews
        `),
        bootstrapDb.query(`
          SELECT t.id, t.name, t.cover, t.create_time, COUNT(DISTINCT a.id) AS article_count
          FROM tag t
          LEFT JOIN article_tag at2 ON t.id = at2.tag_id
          LEFT JOIN article a ON at2.article_id = a.id AND a.status = 1
          GROUP BY t.id, t.name, t.cover, t.create_time
          ORDER BY t.create_time DESC
        `),
        bootstrapDb.query(`
          SELECT c.id, c.content, c.create_time,
                 u.nickname AS user_name, u.avatar AS user_avatar,
                 a.title AS article_title, a.id AS article_id
          FROM comment c
          LEFT JOIN user u ON c.user_id = u.id
          LEFT JOIN article a ON c.article_id = a.id
          ORDER BY c.create_time DESC
          LIMIT 5
        `),
        bootstrapDb.query("SELECT id, title, artist, album, duration_sec, duration_str, cover, url, is_active, sort_order FROM music WHERE is_active = 1 ORDER BY sort_order ASC, id ASC").catch(() => [[]]),
      ]);

      const agg = aggRows[0] || {};
      const stats = {
        articles: Number(agg.articles || 0),
        categories: Number(agg.categories || 0),
        tags: Number(agg.tags || 0),
        comments: Number(agg.comments || 0),
        totalViews: Number(agg.totalViews || 0),
      };

      const normalizedComments = comments.map((c) => {
        const av = c.user_avatar && c.user_avatar.startsWith("http://hxiuji.top")
          ? c.user_avatar.replace("http://hxiuji.top", "https://hxiuji.top")
          : c.user_avatar;
        return {
          ...c,
          user_avatar: bootstrapStorage.sign(av) || BOOTSTRAP_DEFAULT_AVATAR,
        };
      });

      raw = {
        banners,
        stats,
        tags,
        comments: normalizedComments,
        playlist: playlistRows && playlistRows.length > 0 ? playlistRows : BOOTSTRAP_DEFAULT_PLAYLIST,
      };
      bootstrapCache.set(cacheKey, raw, 15000);
    }

    const banners = raw.banners.map((b) => bootstrapStorage.attachUrls({ ...b }, { media_url: "media_signed_url" }));
    const tags = raw.tags.map((t) => bootstrapStorage.attachUrls({ ...t }, { cover: "cover_url" }));
    const playlist = raw.playlist.map((s) => bootstrapStorage.attachUrls({ ...s }, { url: "play_url", cover: "cover_url" }));

    return res.json({
      code: 200,
      message: "获取首页聚合数据成功",
      data: {
        banners,
        stats: raw.stats,
        categories: categoriesRes.data || [],
        tags,
        recommend: recommendRes.data || [],
        hot: hotRes.data || [],
        latest: latestRes.data || { list: [], total: 0, page: 1, pageSize: 6, totalPage: 0 },
        comments: raw.comments,
        playlist,
      },
    });
  } catch (error) {
    console.error("获取首页聚合数据失败:", error);
    return res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};
