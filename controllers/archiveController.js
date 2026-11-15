const db = require("../config/db");
const cache = require("../utils/cache");
const storage = require("../services/storage");

// 获取归档列表（按年月分组，含封面、分类、阅读数）
exports.getArchives = async (req, res) => {
  try {
    const cacheKey = "archives_list";
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      return res.json({ code: 200, message: "获取归档成功(缓存)", data: cachedData });
    }

    const [articles] = await db.query(
      `SELECT a.id, a.title, a.cover, a.view_count, a.create_time, c.name AS category_name
       FROM article a
       LEFT JOIN category c ON a.category_id = c.id
       WHERE a.status = 1
       ORDER BY a.create_time DESC`
    );

    storage.attachUrls(articles, { cover: "cover_url" });

    const grouped = {};
    articles.forEach((article) => {
      const date = new Date(article.create_time);
      const ym =
        date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
      if (!grouped[ym]) {
        grouped[ym] = [];
      }
      grouped[ym].push({
        id: article.id,
        title: article.title,
        cover: article.cover,
        cover_url: article.cover_url,
        view_count: article.view_count || 0,
        category_name: article.category_name || '未分类',
        create_time: article.create_time,
      });
    });

    const archives = Object.keys(grouped).map((ym) => ({
      year_month: ym,
      count: grouped[ym].length,
      articles: grouped[ym],
    }));

    const data = {
      total: articles.length,
      archives: archives,
    };

    cache.set(cacheKey, data, 60000); // 缓存 60s

    res.json({
      code: 200,
      message: "获取归档成功",
      data,
    });
  } catch (error) {
    console.error("获取归档错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};
