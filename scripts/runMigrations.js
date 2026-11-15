const db = require("../config/db");
const { ensureMusicTable } = require("./setupMusic");
const { ensureRecommendOrder } = require("./setupRecommend");
const { ensureArticleReviewColumns } = require("./setupArticleReview");
const { ensureIndexes } = require("./setupIndexes");
const { ensureAiTables } = require("./setupAiTables");
const { ensureUnifiedOptimizations } = require("./setupOptimizations");
const { ensureMessageWallTables } = require("./setupMessageWall");

async function ensureCoreSchemaColumns() {
  const alts = [
    "ALTER TABLE user ADD COLUMN last_login_ip VARCHAR(45) DEFAULT NULL",
    "ALTER TABLE category ADD COLUMN cover VARCHAR(500) DEFAULT NULL",
    "ALTER TABLE tag ADD COLUMN cover VARCHAR(500) DEFAULT NULL",
    "ALTER TABLE comment MODIFY COLUMN user_id INT UNSIGNED DEFAULT NULL",
    "ALTER TABLE comment ADD COLUMN guest_name VARCHAR(64) DEFAULT '热心网友'",
    "ALTER TABLE comment ADD COLUMN guest_reply_to VARCHAR(64) DEFAULT ''",
  ];
  for (const sql of alts) {
    await db.query(sql).catch(() => {});
  }
}

/**
 * 统一数据库迁移与结构自检调度器
 * ------------------------------------------------------------------
 * 解决问题：
 * 历史实现中 7 个自检脚本在服务启动时并发无序触发，多次 ALTER TABLE / CREATE INDEX
 * 争抢 MySQL InnoDB 表元数据锁 (Metadata Lock, MDL)，可能引发死锁或锁等待超时。
 * 现采用受控的顺序执行管道，保障幂等、顺序性，并支持通过 SKIP_DB_BOOTSTRAP 禁用。
 */
async function runAllMigrations() {
  if (process.env.SKIP_DB_BOOTSTRAP === "true") {
    console.log("--- ⏩ 跳过数据库启动自检迁移 (SKIP_DB_BOOTSTRAP=true) ---");
    return;
  }

  console.log("--- 📦 开始执行数据库自检与结构迁移流程 (按序幂等执行) ---");

  const migrationSteps = [
    { name: "基础表增量字段 (user/category/tag/comment)", fn: ensureCoreSchemaColumns },
    { name: "音乐模块 (music 表与预置种子)", fn: ensureMusicTable },
    { name: "精选推荐列 (article.recommend_order)", fn: ensureRecommendOrder },
    { name: "审核状态与字段 (article review columns)", fn: ensureArticleReviewColumns },
    { name: "核心加速复合索引 (setupIndexes)", fn: ensureIndexes },
    { name: "AI 对话与知识库表 (setupAiTables)", fn: ensureAiTables },
    { name: "全站复合查询优化索引 (setupOptimizations)", fn: ensureUnifiedOptimizations },
    { name: "留言墙模块 (message_wall 表与种子)", fn: ensureMessageWallTables },
  ];

  for (const step of migrationSteps) {
    try {
      await step.fn();
    } catch (err) {
      console.error(`--- ⚠️ [迁移自检] ${step.name} 执行告警:`, err.message);
    }
  }

  console.log("--- ✅ 数据库自检与结构迁移流程执行完毕 ---");
}

module.exports = { runAllMigrations };
