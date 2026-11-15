const express = require("express");
const router = express.Router();
const aiController = require("../controllers/aiController");
const authMiddleware = require("../middlewares/authMiddleware");
const optionalAuthMiddleware = require("../middlewares/optionalAuthMiddleware");
const adminMiddleware = require("../middlewares/adminMiddleware");

const upload = require("../middlewares/upload");

// ========== AI 流式问答 (支持游客/登录用户) ==========
router.post("/chat/stream", optionalAuthMiddleware, aiController.streamChat);

// ========== 会话管理 ==========
router.get("/conversations", optionalAuthMiddleware, aiController.getConversations);
router.get("/conversations/:id/messages", optionalAuthMiddleware, aiController.getMessages);
router.delete("/conversations/:id", optionalAuthMiddleware, aiController.deleteConversation);

// ========== 管理端：AI 监管与对话审计 ==========
router.get("/admin/conversations", authMiddleware, adminMiddleware, aiController.getAdminConversations);
router.get("/admin/conversations/:id/messages", authMiddleware, adminMiddleware, aiController.getAdminConversationMessages);
router.delete("/admin/conversations/:id", authMiddleware, adminMiddleware, aiController.deleteAdminConversation);
router.get("/admin/stats", authMiddleware, adminMiddleware, aiController.getAdminAiStats);

// ========== AI 文章摘要与写作 Co-Pilot ==========
router.post("/summarize", optionalAuthMiddleware, aiController.generateSummary);
router.post("/copilot/titles", authMiddleware, aiController.generateTitles);

// ========== RAG 知识库文档管理（仅管理员：防止普通用户污染/删除知识库） ==========
router.get("/documents", authMiddleware, adminMiddleware, aiController.getDocuments);
router.post("/documents/upload", authMiddleware, adminMiddleware, upload.docMemory.single("file"), aiController.uploadDocument);
router.delete("/documents/:id", authMiddleware, adminMiddleware, aiController.deleteDocument);

// ========== AI 大模型配置（仅管理员：配置中含 apiKey，禁止游客/普通用户读取或篡改） ==========
router.get("/settings", authMiddleware, adminMiddleware, aiController.getSettings);
router.post("/settings", authMiddleware, adminMiddleware, aiController.saveSettings);

module.exports = router;
