/**
 * Article 控制器（薄层）
 * ------------------------------------------------------------------
 * 只做 HTTP 入参 / 响应映射，业务逻辑在 articleService 与
 * articleInteractionService。
 */
const article = require("../services/articleService");
const interaction = require("../services/articleInteractionService");
const { getClientIp } = require("../utils/clientIp");

async function respond(res, promise) {
  try {
    const r = await promise;
    const status = r.status || 200;
    return res.status(status).json({ code: status, message: r.message, data: r.data });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("文章接口异常:", err);
    // 5xx 不回显内部信息，4xx 返回具体提示
    const message = status >= 500 ? "服务器内部错误" : err.message;
    return res.status(status).json({ code: status, message });
  }
}

// 核心 CRUD / 查询
exports.createArticle = (req, res) => respond(res, article.createArticle(req.body, req.user));
exports.getArticleList = (req, res) => respond(res, article.getArticleList(req.query));
exports.updateArticle = (req, res) =>
  respond(res, article.updateArticle(req.params.id, req.body, req.user));
exports.deleteArticle = (req, res) =>
  respond(res, article.deleteArticle(req.params.id, req.user));
exports.getArticleById = (req, res) =>
  respond(res, article.getArticleById(req.params.id, req.user, getClientIp(req)));
exports.searchArticles = (req, res) =>
  respond(res, article.searchArticles(req.query.keyword));
exports.getHotArticles = (req, res) =>
  respond(res, article.getHotArticles(parseInt(req.query.limit) || 6));
exports.getLatestArticles = (req, res) =>
  respond(res, article.getLatestArticles(parseInt(req.query.limit) || 6));
exports.getArticleNav = (req, res) =>
  respond(res, article.getArticleNav(parseInt(req.params.id)));
exports.getRecommendArticles = (req, res) =>
  respond(res, article.getRecommendArticles(parseInt(req.query.limit) || 5));
exports.getArticleStats = (req, res) =>
  respond(res, article.getArticleStats(req.params.id));
exports.getAdminArticleList = (req, res) =>
  respond(res, article.getAdminArticleList(req.query));
exports.reviewArticle = (req, res) =>
  respond(res, article.reviewArticle(req.params.id, req.body, req.user));

// 交互：点赞 / 推荐
exports.likeArticle = (req, res) =>
  respond(res, interaction.likeArticle(req.params.id, req.user));
exports.getLikeStatus = (req, res) =>
  respond(res, interaction.getLikeStatus(req.params.id, req.user));
exports.getArticleLikes = (req, res) =>
  respond(res, interaction.getArticleLikes(req.params.id));
exports.toggleRecommend = (req, res) =>
  respond(res, interaction.toggleRecommend(req.params.id, req.body.is_recommend));
exports.setRecommendBatch = (req, res) =>
  respond(res, interaction.setRecommendBatch(req.body));
