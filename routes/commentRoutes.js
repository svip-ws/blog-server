const express = require("express");
const router = express.Router();
const commentController = require("../controllers/commentController");
const authMiddleware = require("../middlewares/authMiddleware");
const optionalAuthMiddleware = require("../middlewares/optionalAuthMiddleware");
const adminMiddleware = require("../middlewares/adminMiddleware");

// 1. 管理端路由（高优先级，避免与 /:articleId 混淆）
router.get(
  "/admin/list",
  authMiddleware,
  adminMiddleware,
  commentController.getCommentList,
);
router.get(
  "/admin/detail/:id",
  authMiddleware,
  adminMiddleware,
  commentController.getCommentById,
);
router.delete(
  "/admin/:id",
  authMiddleware,
  adminMiddleware,
  commentController.adminDeleteComment,
);

// 2. 公开只读路由
router.get("/latest", commentController.getLatestComments);
router.get("/:articleId", optionalAuthMiddleware, commentController.getCommentsByArticle);

// 3. 互动路由 (发表评论支持全网游客/登录用户柔性发表)
router.post("/", optionalAuthMiddleware, commentController.createComment);
router.post("/:id/like", optionalAuthMiddleware, commentController.likeComment);
router.delete("/:id", authMiddleware, commentController.deleteUserComment);

module.exports = router;
