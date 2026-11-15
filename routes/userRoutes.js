const express = require("express");
const router = express.Router();
const userController = require("../controllers/userController");
const authMiddleware = require("../middlewares/authMiddleware");
const adminMiddleware = require("../middlewares/adminMiddleware");
const { authLimiter } = require("../middlewares/rateLimitMiddleware");
const upload = require("../middlewares/upload");

// ========== 公开接口（带防爆破限流） ==========
router.post("/register", authLimiter, userController.register);
router.post("/login", authLimiter, userController.login);
router.post("/wx-login", authLimiter, userController.wxLogin);
router.get("/admin", userController.getAdminInfo);

// ========== 需要登录 ==========
router.get("/info", authMiddleware, userController.getUserInfo);
router.get("/profile", authMiddleware, userController.getUserProfile);
router.get("/articles", authMiddleware, userController.getUserArticles);
router.get("/comments", authMiddleware, userController.getUserComments);
router.put("/profile", authMiddleware, userController.updateProfile);
router.post(
  "/avatar",
  authMiddleware,
  upload.imageMemory.single("avatar"),
  userController.uploadAvatar,
);
router.put("/password", authMiddleware, userController.changePassword);

// ========== 管理员接口 ==========
router.get(
  "/list",
  authMiddleware,
  adminMiddleware,
  userController.getUserList,
);
router.get("/:id", authMiddleware, adminMiddleware, userController.getUserById);
router.post("/", authMiddleware, adminMiddleware, userController.createUser);
router.put("/:id", authMiddleware, adminMiddleware, userController.updateUser);
router.put(
  "/status/:id",
  authMiddleware,
  adminMiddleware,
  userController.toggleUserStatus,
);
router.delete(
  "/:id",
  authMiddleware,
  adminMiddleware,
  userController.deleteUser,
);

module.exports = router;
