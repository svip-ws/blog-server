const express = require("express");
const router = express.Router();
const messageController = require("../controllers/messageController");
const authMiddleware = require("../middlewares/authMiddleware");
const optionalAuthMiddleware = require("../middlewares/optionalAuthMiddleware");

const adminMiddleware = require("../middlewares/adminMiddleware");
const { messageLimiter } = require("../middlewares/rateLimitMiddleware");

// ================= 管理端接口 (需管理员权限) =================
// 注意：静态 admin 路由必须放在动态 /:id 路由之前，避免被误匹配为 id="admin"
router.get("/admin/list", authMiddleware, adminMiddleware, messageController.getAdminMessageList);
router.get("/admin/export", authMiddleware, adminMiddleware, messageController.exportAdminMessages);
router.post("/admin/batch", authMiddleware, adminMiddleware, messageController.batchAdminMessages);
router.get("/admin/replies/:messageId", authMiddleware, adminMiddleware, messageController.getAdminReplies);
router.post("/admin/replies/:messageId", authMiddleware, adminMiddleware, messageController.adminReplyMessage);
router.delete("/admin/reply/:id", authMiddleware, adminMiddleware, messageController.deleteAdminReply);
router.put("/admin/:id/status", authMiddleware, adminMiddleware, messageController.updateAdminMessageStatus);
router.delete("/admin/:id", authMiddleware, adminMiddleware, messageController.deleteAdminMessage);

// ================= 客户端公开接口 =================
// 获取展示中的留言列表（全公开）
router.get("/active", messageController.getActiveMessages);

// 发表留言（支持游客 + 已登录用户，限流 + 敏感词）
router.post("/", messageLimiter, optionalAuthMiddleware, messageController.createMessage);

// 点赞留言（支持游客 IP 去重与已登录用户账号绑定，支持 toggle 点赞/取消）
router.post("/:id/like", optionalAuthMiddleware, messageController.likeMessage);

// 回复留言（支持游客 + 已登录用户，限流 + 敏感词）
router.post("/:id/reply", messageLimiter, optionalAuthMiddleware, messageController.replyMessage);

// 获取用户点赞状态（支持登录用户及游客）
router.get("/liked", optionalAuthMiddleware, messageController.getLikedStatus);

// 删除自己的留言（仅登录用户，且只能删自己发的）
router.delete("/:id", optionalAuthMiddleware, messageController.deleteOwnMessage);

module.exports = router;
