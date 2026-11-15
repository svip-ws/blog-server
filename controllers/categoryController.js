/**
 * Category 控制器（薄层）
 * ------------------------------------------------------------------
 * 只做 HTTP 入参 / 响应映射，业务与数据处理委托给 categoryService。
 */
const categoryService = require("../services/categoryService");

async function respond(res, promise) {
  try {
    const r = await promise;
    const status = r.status || 200;
    return res.status(status).json({ code: status, message: r.message, data: r.data });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("[category] 接口异常:", err);
    const message = status >= 500 ? "服务器内部错误" : err.message;
    return res.status(status).json({ code: status, message });
  }
}

exports.createCategory = (req, res) => respond(res, categoryService.createCategory(req.body));
exports.getAllCategories = (req, res) => respond(res, categoryService.getAllCategories());
exports.getCategoryById = (req, res) => respond(res, categoryService.getCategoryById(req.params.id));
exports.updateCategory = (req, res) => respond(res, categoryService.updateCategory(req.params.id, req.body));
exports.deleteCategory = (req, res) => respond(res, categoryService.deleteCategory(req.params.id));
