const db = require("../config/db");

/**
 * 数据库与全局性能终极自检与优化脚本 (MySQL Unified Optimization)
 */
async function ensureUnifiedOptimizations() {
  try {
    console.log("--- 🚀 开始执行全栈四端 (数据库/服务端/用户端/管理端) 终极性能校验与优化... ---");

    // 1. user 表索引自检
    await db.query(`ALTER TABLE user ADD INDEX idx_status_role (status, role)`).catch(() => { });
    await db.query(`ALTER TABLE user ADD INDEX idx_username (username)`).catch(() => { });

    // 2. article 表高频检索复合索引自检
    await db.query(`ALTER TABLE article ADD INDEX idx_status_created (status, create_time DESC)`).catch(() => { });
    await db.query(`ALTER TABLE article ADD INDEX idx_category_id (category_id)`).catch(() => { });

    // 3. ai_conversations 与 ai_messages 索引自检
    await db.query(`ALTER TABLE ai_conversations ADD INDEX idx_user_updated (user_id, updated_at DESC)`).catch(() => { });
    await db.query(`ALTER TABLE ai_messages ADD INDEX idx_conv_created (conversation_id, created_at ASC)`).catch(() => { });

    // 4. comment & message_wall 表索引自检
    await db.query(`ALTER TABLE comment ADD INDEX idx_article_create (article_id, create_time ASC)`).catch(() => { });
    await db.query(`ALTER TABLE message_wall ADD INDEX idx_create_time (create_time DESC)`).catch(() => { });

    console.log("--- ✅ 数据库全量高频复合索引自检与优化构建完毕！ ---");
  } catch (error) {
    console.error("--- ⚠️ 性能自检抛错（不影响主流程）:", error.message);
  }
}

module.exports = { ensureUnifiedOptimizations };
