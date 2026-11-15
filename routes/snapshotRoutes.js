const express = require("express");
const router = express.Router();
const snapshotController = require("../controllers/snapshotController");
const authMiddleware = require("../middlewares/authMiddleware");
const adminMiddleware = require("../middlewares/adminMiddleware");
const upload = require("../middlewares/upload");

// 管理员接口（后台）- 必须在 /:id 之前注册！
router.get(
  "/admin/list",
  authMiddleware,
  adminMiddleware,
  snapshotController.getAllSnapshots
);
router.post(
  "/",
  authMiddleware,
  adminMiddleware,
  upload.imageMemory.single("file"),
  snapshotController.createSnapshot
);
router.get(
  "/:id/status",
  authMiddleware,
  adminMiddleware,
  snapshotController.getPipelineStatus
);
router.post(
  "/:id/retry",
  authMiddleware,
  adminMiddleware,
  snapshotController.retryPipeline
);
router.put(
  "/:id",
  authMiddleware,
  adminMiddleware,
  snapshotController.updateSnapshot
);
router.delete(
  "/:id",
  authMiddleware,
  adminMiddleware,
  snapshotController.deleteSnapshot
);

const optionalAuthMiddleware = require("../middlewares/optionalAuthMiddleware");

// 公开接口（前台访客）
router.get("/list", snapshotController.getSnapshotList);
router.get("/categories", snapshotController.getCategories);
router.get("/:id", snapshotController.getSnapshotById);
router.post("/:id/like", optionalAuthMiddleware, snapshotController.likeSnapshot);

module.exports = router;


