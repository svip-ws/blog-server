const express = require("express");
const router = express.Router();
const musicController = require("../controllers/musicController");
const authMiddleware = require("../middlewares/authMiddleware");
const adminMiddleware = require("../middlewares/adminMiddleware");
const upload = require("../middlewares/upload");

// 公开接口
router.get("/playlist", musicController.getPlaylist);
router.get("/now-playing", musicController.getNowPlaying);

// 音频上传（管理员）
router.post(
  "/upload",
  authMiddleware,
  adminMiddleware,
  upload.audioMemory.single("file"),
  musicController.uploadMusic
);

// 管理员接口
router.get("/", authMiddleware, adminMiddleware, musicController.getAllMusic);
router.get("/:id", authMiddleware, adminMiddleware, musicController.getMusicById);
router.post("/", authMiddleware, adminMiddleware, musicController.createMusic);
router.put("/:id", authMiddleware, adminMiddleware, musicController.updateMusic);
router.delete(
  "/:id",
  authMiddleware,
  adminMiddleware,
  musicController.deleteMusic
);

module.exports = router;
