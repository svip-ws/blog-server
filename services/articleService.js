/**
 * Article 核心领域服务
 * ------------------------------------------------------------------
 * 文章 CRUD、列表/详情/搜索、热门/最新/推荐读取、上下篇、统计、
 * 管理端列表与审核。控制器只做 HTTP 映射。
 * 方法返回 { status, message, data }；业务错误抛 HttpError。
 */
const db = require("../config/db");
const { isAdmin } = require("../utils/role");
const { ARTICLE_STATUS } = require("../utils/articleStatus");
const { HEAT_CONFIG, getHeatSqlExpression } = require("../config/heatConfig");
const cache = require("../utils/cache");
const { cleanArticleContent, cleanPlainText } = require("../utils/sanitizeHtml");
const viewCountBuffer = require("../utils/viewCountBuffer");
const storage = require("./storage");
const { signContentImages, contentUrlsToKeys } = require("../utils/contentImages");

// 文章结果中需转可访问链接的文件字段：原字段(存 key) → 显示字段
const FILE_FIELDS = { cover: "cover_url", author_avatar: "author_avatar_url" };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const ok = (data, message = "获取成功", status = 200) => ({ status, message, data });

// 同步文章-标签关联（先清后插）
async function syncArticleTags(articleId, tagIds) {
  await db.query("DELETE FROM article_tag WHERE article_id = ?", [articleId]);
  if (tagIds && tagIds.length > 0) {
    const values = tagIds.map((tagId) => [articleId, tagId]);
    await db.query("INSERT INTO article_tag (article_id, tag_id) VALUES ?", [values]);
  }
}

// 1. 创建文章
async function createArticle(data, user) {
  const { title, description, content, cover, category_id, status, tagIds, is_recommend } = data;
  const admin = isAdmin(user.role);

  if (!title || !content) fail(400, "文章标题和正文不能为空");

  const safeTitle = cleanPlainText(title).trim();
  const safeDescription = description ? cleanPlainText(description).trim() : null;
  const safeContent = contentUrlsToKeys(cleanArticleContent(content));

  const wantDraft = Number(status) === ARTICLE_STATUS.DRAFT;
  const targetStatus = wantDraft
    ? ARTICLE_STATUS.DRAFT
    : admin ? ARTICLE_STATUS.PUBLISHED : ARTICLE_STATUS.PENDING;

  const [result] = await db.query(
    `INSERT INTO article (title, description, content, cover, category_id, user_id, status, is_recommend)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [safeTitle, safeDescription, safeContent, cover, category_id, user.id, targetStatus, admin ? is_recommend || 0 : 0]
  );

  if (tagIds && tagIds.length > 0) {
    const values = tagIds.map((tagId) => [result.insertId, tagId]);
    await db.query("INSERT INTO article_tag (article_id, tag_id) VALUES ?", [values]);
  }
  cache.clear();

  const message =
    targetStatus === ARTICLE_STATUS.DRAFT ? "草稿保存成功"
    : targetStatus === ARTICLE_STATUS.PENDING ? "文章已提交，等待管理员审核"
    : "文章发布成功";

  return ok({ id: result.insertId, status: targetStatus }, message, 201);
}

// 统一把文章行的 tag 字符串转数组
function shapeArticle(article) {
  return {
    ...article,
    tag_names: article.tag_names ? article.tag_names.split(",") : [],
    tag_ids: article.tag_ids ? article.tag_ids.split(",").map(Number) : [],
  };
}

// 2. 公开文章列表
async function getArticleList(query) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize) || 10));
  const categoryId = query.category_id;
  const tagId = query.tag_id;
  const rawSort = query.sort || query.sort_by;
  const sort = HEAT_CONFIG.allowedSorts.includes(rawSort) ? rawSort : HEAT_CONFIG.defaultSort;

  const cacheKey = `article_list_${page}_${pageSize}_${categoryId || ""}_${tagId || ""}_${sort}`;
  const cachedData = cache.get(cacheKey);
  if (cachedData) {
    storage.attachUrls(cachedData.list, FILE_FIELDS);
    return ok(cachedData, "获取文章列表成功(缓存)");
  }

  const offset = (page - 1) * pageSize;

  let querySql = `
    SELECT a.id, a.title, a.description, a.cover, a.view_count, a.like_count, a.comment_count, a.status, a.is_recommend, a.recommend_order, a.create_time,
           c.name AS category_name, u.nickname AS author_name, u.avatar AS author_avatar,
           GROUP_CONCAT(DISTINCT t.name) AS tag_names, GROUP_CONCAT(DISTINCT t.id) AS tag_ids
    FROM article a
    LEFT JOIN category c ON a.category_id = c.id
    LEFT JOIN user u ON a.user_id = u.id
    LEFT JOIN article_tag at2 ON a.id = at2.article_id
    LEFT JOIN tag t ON at2.tag_id = t.id
    WHERE a.status = 1
  `;
  let countSql = `SELECT COUNT(*) AS total FROM article WHERE status = 1`;
  const queryParams = [];
  const countParams = [];

  if (categoryId) {
    querySql += ` AND a.category_id = ?`;
    countSql += ` AND category_id = ?`;
    queryParams.push(categoryId); countParams.push(categoryId);
  }
  if (tagId) {
    querySql += ` AND EXISTS (SELECT 1 FROM article_tag at3 WHERE at3.article_id = a.id AND at3.tag_id = ?)`;
    countSql += ` AND EXISTS (SELECT 1 FROM article_tag at4 WHERE at4.article_id = article.id AND at4.tag_id = ?)`;
    queryParams.push(tagId); countParams.push(tagId);
  }

  let orderClause;
  if (sort === "hot") {
    orderClause = ` ORDER BY ${getHeatSqlExpression("a")} DESC, a.create_time DESC, a.id DESC`;
  } else {
    orderClause = ` ORDER BY a.create_time DESC, a.id DESC`;
  }

  querySql += ` GROUP BY a.id${orderClause} LIMIT ? OFFSET ?`;
  queryParams.push(pageSize, offset);

  const [countResultTask, listResultTask] = await Promise.all([
    db.query(countSql, countParams), db.query(querySql, queryParams),
  ]);

  const total = countResultTask[0][0].total;
  const articles = listResultTask[0].map(shapeArticle);
  const data = { list: articles, total, page, pageSize, totalPage: Math.ceil(total / pageSize) };

  cache.set(cacheKey, data, 20000);
  storage.attachUrls(data.list, FILE_FIELDS);
  return ok(data, "获取文章列表成功");
}

// 3. 修改文章
async function updateArticle(id, data, user) {
  const { title, description, content, cover, category_id, status, tagIds, is_recommend } = data;
  const admin = isAdmin(user.role);

  const [articles] = await db.query(
    "SELECT title, description, content, cover, category_id, user_id, status, is_recommend FROM article WHERE id = ?", [id]
  );
  if (articles.length === 0) fail(404, "文章不存在");
  const existing = articles[0];
  if (existing.user_id !== user.id && !admin) fail(403, "权限不足：你只能编辑自己的文章");

  let nextStatus;
  if (admin) {
    nextStatus = status === undefined || status === null || status === ""
      ? existing.status : Number(status);
  } else {
    nextStatus = Number(status) === ARTICLE_STATUS.DRAFT
      ? ARTICLE_STATUS.DRAFT : ARTICLE_STATUS.PENDING;
  }

  const clearReview = nextStatus === ARTICLE_STATUS.PENDING || nextStatus === ARTICLE_STATUS.DRAFT;

  const safeTitle = title !== undefined ? cleanPlainText(title).trim() : existing.title;
  const safeDescription = description !== undefined ? (description ? cleanPlainText(description).trim() : null) : existing.description;
  const safeContent = content !== undefined ? contentUrlsToKeys(cleanArticleContent(content)) : existing.content;
  const safeCover = cover !== undefined ? cover : existing.cover;
  const safeCategoryId = category_id !== undefined ? category_id : existing.category_id;

  await db.query(
    `UPDATE article
     SET title = ?, description = ?, content = ?, cover = ?, category_id = ?, status = ?, is_recommend = ?
         ${clearReview ? ", reject_reason = NULL, reviewed_by = NULL, reviewed_time = NULL" : ""}
     WHERE id = ?`,
    [safeTitle, safeDescription, safeContent, safeCover, safeCategoryId, nextStatus,
     admin ? (is_recommend !== undefined ? is_recommend : existing.is_recommend || 0) : existing.is_recommend || 0, id]
  );

  if (Array.isArray(tagIds)) {
    await syncArticleTags(id, tagIds);
  }
  cache.clear();

  const message = !admin && nextStatus === ARTICLE_STATUS.PENDING
    ? "文章已更新并重新提交审核" : "文章更新成功";
  return ok({ status: nextStatus }, message);
}

// 4. 删除文章
async function deleteArticle(id, user) {
  const [articles] = await db.query("SELECT user_id FROM article WHERE id = ?", [id]);
  if (articles.length === 0) fail(404, "文章不存在");
  if (articles[0].user_id !== user.id && !isAdmin(user.role)) {
    fail(403, "权限不足：你只能删除自己的文章");
  }
  await db.query("DELETE FROM article_tag WHERE article_id = ?", [id]);
  await db.query("DELETE FROM article WHERE id = ?", [id]);
  cache.clear();
  return ok(null, "文章删除成功");
}

// 文章行的通用 JOIN 片段
const ARTICLE_SELECT = `
  SELECT a.id, a.title, a.description, a.cover, a.view_count, a.like_count, a.create_time,
         c.name AS category_name, u.nickname AS author_name, u.avatar AS author_avatar,
         GROUP_CONCAT(DISTINCT t.name) AS tag_names, GROUP_CONCAT(DISTINCT t.id) AS tag_ids
  FROM article a
  LEFT JOIN category c ON a.category_id = c.id
  LEFT JOIN user u ON a.user_id = u.id
  LEFT JOIN article_tag at2 ON a.id = at2.article_id
  LEFT JOIN tag t ON at2.tag_id = t.id
`;

// 5. 文章详情
async function getArticleById(id, user, clientIp = "") {
  const sql = `
    SELECT a.*, c.name AS category_name, u.nickname AS author_name, u.avatar AS author_avatar,
           GROUP_CONCAT(DISTINCT t.name) AS tag_names, GROUP_CONCAT(DISTINCT t.id) AS tag_ids
    FROM article a
    LEFT JOIN category c ON a.category_id = c.id
    LEFT JOIN user u ON a.user_id = u.id
    LEFT JOIN article_tag at2 ON a.id = at2.article_id
    LEFT JOIN tag t ON at2.tag_id = t.id
    WHERE a.id = ? GROUP BY a.id
  `;
  const [articles] = await db.query(sql, [id]);
  if (articles.length === 0) fail(404, "文章不存在或已被删除");

  const article = articles[0];

  if (article.status !== 1) {
    const requesterId = user ? user.id : null;
    const canPreview = requesterId &&
      (article.user_id === requesterId || isAdmin(user.role));
    if (!canPreview) fail(404, "文章不存在或已被删除");
  } else {
    // 异步缓冲递增浏览量，解决高并发访问同一文章时的数据库行级排队写锁，并应用 10 分钟 IP 冷却去重
    viewCountBuffer.recordArticle(id, clientIp);
    article.view_count = (article.view_count || 0) + viewCountBuffer.getPendingCount("article", id);
  }

  const detail = shapeArticle(article);
  storage.attachUrls(detail, FILE_FIELDS);
  detail.content = signContentImages(detail.content);
  return ok(detail, "获取文章详情成功");
}

// 6. 搜索文章
async function searchArticles(keyword) {
  if (!keyword || !keyword.trim()) fail(400, "搜索关键词不能为空");
  const likeKeyword = `%${keyword.trim()}%`;

  const sql = `
    ${ARTICLE_SELECT}
    WHERE a.status = 1 AND (a.title LIKE ? OR a.description LIKE ?)
    GROUP BY a.id ORDER BY a.create_time DESC LIMIT 50
  `;
  const [articles] = await db.query(sql, [likeKeyword, likeKeyword]);
  const searchData = { keyword: keyword.trim(), total: articles.length, list: articles.map(shapeArticle) };
  storage.attachUrls(searchData.list, FILE_FIELDS);
  return ok(searchData, "搜索成功");
}

// 7. 热门文章
async function getHotArticles(limit) {
  const cacheKey = `hot_articles_${limit}`;
  const cachedData = cache.get(cacheKey);
  if (cachedData) {
    storage.attachUrls(cachedData, FILE_FIELDS);
    return ok(cachedData, "获取成功(缓存)");
  }

  const sql = `
    ${ARTICLE_SELECT}
    WHERE a.status = 1 GROUP BY a.id
    ORDER BY a.view_count DESC, a.like_count DESC LIMIT ?
  `;
  const [articles] = await db.query(sql, [limit]);
  const formatted = articles.map(shapeArticle);
  cache.set(cacheKey, formatted, 30000);
  storage.attachUrls(formatted, FILE_FIELDS);
  return ok(formatted);
}

// 8. 最新文章
async function getLatestArticles(limit) {
  const cacheKey = `latest_articles_${limit}`;
  const cachedData = cache.get(cacheKey);
  if (cachedData) {
    storage.attachUrls(cachedData, FILE_FIELDS);
    return ok(cachedData, "获取成功(缓存)");
  }

  const sql = `
    ${ARTICLE_SELECT}
    WHERE a.status = 1 GROUP BY a.id ORDER BY a.create_time DESC LIMIT ?
  `;
  const [articles] = await db.query(sql, [limit]);
  const formatted = articles.map(shapeArticle);
  cache.set(cacheKey, formatted, 30000);
  storage.attachUrls(formatted, FILE_FIELDS);
  return ok(formatted);
}

// 上下篇
async function getArticleNav(articleId) {
  const [current] = await db.query("SELECT create_time FROM article WHERE id = ? AND status = 1", [articleId]);
  if (current.length === 0) fail(404, "文章不存在");

  const createTime = current[0].create_time;
  const [[prevRows], [nextRows]] = await Promise.all([
    db.query(
      "SELECT id, title FROM article WHERE status = 1 AND create_time > ? ORDER BY create_time ASC LIMIT 1",
      [createTime]
    ),
    db.query(
      "SELECT id, title FROM article WHERE status = 1 AND create_time < ? ORDER BY create_time DESC LIMIT 1",
      [createTime]
    ),
  ]);
  return ok({
    prev: prevRows.length > 0 ? prevRows[0] : null,
    next: nextRows.length > 0 ? nextRows[0] : null,
  });
}

// 推荐文章（编辑精选）
async function getRecommendArticles(limit) {
  const cacheKey = `recommend_articles_${limit}`;
  const cachedData = cache.get(cacheKey);
  if (cachedData) {
    storage.attachUrls(cachedData, FILE_FIELDS);
    return ok(cachedData, "获取成功(缓存)");
  }

  const sql = `
    SELECT a.id, a.title, a.cover, a.view_count, a.like_count,
           c.name AS category_name, u.nickname AS author_name, u.avatar AS author_avatar,
           DATE_FORMAT(a.create_time, '%Y-%m-%d') AS date_str,
           CONCAT(CEIL(CHAR_LENGTH(a.content) / 300), ' 分钟阅读') AS read_time
    FROM article a
    LEFT JOIN category c ON a.category_id = c.id
    LEFT JOIN user u ON a.user_id = u.id
    WHERE a.status = 1 AND a.is_recommend = 1
    ORDER BY a.recommend_order ASC, a.view_count DESC, a.create_time DESC
    LIMIT ?
  `;
  const [articles] = await db.query(sql, [limit]);
  cache.set(cacheKey, articles, 30000);
  storage.attachUrls(articles, FILE_FIELDS);
  return ok(articles);
}

// 轻量统计
async function getArticleStats(id) {
  const [rows] = await db.query(
    "SELECT id, view_count, like_count, comment_count FROM article WHERE id = ? AND status = 1", [id]
  );
  if (rows.length === 0) fail(404, "文章不存在");
  return ok(rows[0]);
}

// 管理端文章列表
async function getAdminArticleList(query) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize) || 10));
  const title = query.title;
  const status = query.status;
  const offset = (page - 1) * pageSize;

  let where = " WHERE 1 = 1";
  const params = [];
  if (title) { where += " AND a.title LIKE ?"; params.push(`%${title}%`); }
  if (status !== undefined && status !== "" && status !== null && status !== "all") {
    where += " AND a.status = ?"; params.push(Number(status));
  }

  const listSql = `
    SELECT a.id, a.title, a.description, a.cover, a.category_id, a.user_id,
           a.status, a.reject_reason, a.reviewed_by, a.reviewed_time,
           a.view_count, a.like_count, a.comment_count, a.is_recommend, a.recommend_order, a.create_time,
           c.name AS category_name, u.nickname AS author_name, u.username AS author_username,
           ru.nickname AS reviewer_name
    FROM article a
    LEFT JOIN category c ON a.category_id = c.id
    LEFT JOIN user u ON a.user_id = u.id
    LEFT JOIN user ru ON a.reviewed_by = ru.id
    ${where}
    ORDER BY a.create_time DESC
    LIMIT ? OFFSET ?
  `;
  const countSql = `SELECT COUNT(*) AS total FROM article a ${where}`;

  const [listResult, countResult] = await Promise.all([
    db.query(listSql, [...params, pageSize, offset]), db.query(countSql, params),
  ]);

  const total = countResult[0][0].total;
  const adminData = {
    list: listResult[0], total, page, pageSize, totalPage: Math.ceil(total / pageSize),
  };
  storage.attachUrls(adminData.list, FILE_FIELDS);
  return ok(adminData);
}

// 文章审核
async function reviewArticle(id, body, user) {
  const { action, reason } = body;
  if (!["approve", "reject"].includes(action)) fail(400, "无效的审核操作");
  if (action === "reject" && (!reason || !reason.trim())) fail(400, "驳回时必须填写驳回原因");

  const [articles] = await db.query("SELECT id, status FROM article WHERE id = ?", [id]);
  if (articles.length === 0) fail(404, "文章不存在");

  const nextStatus = action === "approve"
    ? ARTICLE_STATUS.PUBLISHED : ARTICLE_STATUS.REJECTED;
  const rejectReason = action === "reject" ? reason.trim() : null;

  await db.query(
    `UPDATE article SET status = ?, reject_reason = ?, reviewed_by = ?, reviewed_time = NOW()
     WHERE id = ?`,
    [nextStatus, rejectReason, user.id, id]
  );
  cache.clear();

  return ok(
    { status: nextStatus },
    action === "approve" ? "审核通过，文章已发布" : "已驳回该文章"
  );
}

module.exports = {
  HttpError,
  createArticle, getArticleList, updateArticle, deleteArticle,
  getArticleById, searchArticles, getHotArticles, getLatestArticles,
  getArticleNav, getRecommendArticles, getArticleStats,
  getAdminArticleList, reviewArticle,
};
