const express = require("express");
const router = express.Router();

const articleController = require("../controllers/articleController");
const authMiddleware = require("../middlewares/authMiddleware");
const adminMiddleware = require("../middlewares/adminMiddleware");
const optionalAuthMiddleware = require("../middlewares/optionalAuthMiddleware");
const upload = require("../middlewares/upload");
const path = require("path");
const sharp = require("sharp");
const storage = require("../services/storage");

// 0. 管理端接口（需管理员权限，且须放在动态 /:id 之前，避免被误匹配）
router.get(
  "/admin/list",
  authMiddleware,
  adminMiddleware,
  articleController.getAdminArticleList,
);

// 1. 公开接口：获取文章列表
router.get("/", articleController.getArticleList);
// 搜索文章（公开接口）
router.get("/search", articleController.searchArticles);
// 获取最热文章（公开接口）
router.get("/hot", articleController.getHotArticles);
// 获取最新文章（公开接口）
router.get("/latest", articleController.getLatestArticles);
// 获取推荐文章（公开接口）
router.get("/recommend", articleController.getRecommendArticles);
// 批量设置编辑精选（管理端写回，需管理员权限）
router.put(
  "/recommend/batch",
  authMiddleware,
  adminMiddleware,
  articleController.setRecommendBatch,
);
// 获取文章导航（公开接口）
router.get("/:id/nav", articleController.getArticleNav);

// 获取单篇文章轻量统计（公开接口）—— 文章详情页实时刷新阅读/点赞/评论计数
router.get("/:id/stats", articleController.getArticleStats);

// 2. 图片上传：内存接收 → 转 WebP → 走存储服务；数据库存 key
const { processAndStoreImage } = require("../utils/imageProcessor");

router.post("/upload", authMiddleware, upload.imageMemory.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ code: 400, message: "请选择要上传的图片" });
    }

    const { key, url } = await processAndStoreImage(req.file, "article");

    res.json({
      code: 200,
      message: "图片上传成功",
      data: { key, url },
    });
  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ code: 400, message: error.message });
    }
    console.error("文章图片上传异常:", error);
    res.status(500).json({ code: 500, message: "图片上传失败" });
  }
});

// 3. 保护接口
router.post("/", authMiddleware, articleController.createArticle);

// 点赞相关（需登录）
router.post("/:id/like", authMiddleware, articleController.likeArticle);
router.get("/:id/like", authMiddleware, articleController.getLikeStatus);

// 点赞详情（管理员）
router.get(
  "/:id/likes",
  authMiddleware,
  adminMiddleware,
  articleController.getArticleLikes,
);

// 文章审核（管理员）：通过 / 驳回
router.put(
  "/:id/review",
  authMiddleware,
  adminMiddleware,
  articleController.reviewArticle,
);

router.put("/:id", authMiddleware, articleController.updateArticle);
router.delete("/:id", authMiddleware, articleController.deleteArticle);
router.put(
  "/:id/recommend",
  authMiddleware,
  adminMiddleware,
  articleController.toggleRecommend,
);

// 动态路由放最后（柔性鉴权：未登录仅可看已发布，作者/管理员可预览非公开状态）
router.get("/:id", optionalAuthMiddleware, articleController.getArticleById);

module.exports = router;
