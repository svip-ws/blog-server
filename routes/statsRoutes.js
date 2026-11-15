const express = require("express");
const router = express.Router();
const statsController = require("../controllers/statsController");

// 公开站点统计聚合：供前端首页、关于页、侧边栏等实时同步站点计数与累计访问量
router.get("/summary", statsController.getSummary);
router.get("/bootstrap", statsController.getHomeBootstrap);

module.exports = router;