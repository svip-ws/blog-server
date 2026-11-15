const db = require("../config/db");

async function ensureAiTables() {
  try {
    // 1. ai_conversations 表
    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_conversations (
        id VARCHAR(64) PRIMARY KEY,
        user_id INT DEFAULT NULL,
        guest_id VARCHAR(64) DEFAULT NULL,
        title VARCHAR(255) DEFAULT '新对话',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_user_id (user_id),
        KEY idx_guest_id (guest_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    await db.query(`ALTER TABLE ai_conversations ADD COLUMN guest_id VARCHAR(64) DEFAULT NULL`).catch(() => {});
    await db.query(`ALTER TABLE ai_conversations ADD INDEX idx_guest_id (guest_id)`).catch(() => {});

    // 2. ai_messages 表
    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        conversation_id VARCHAR(64) NOT NULL,
        role VARCHAR(20) NOT NULL,
        content MEDIUMTEXT NOT NULL,
        meta JSON DEFAULT NULL,
        feedback TINYINT DEFAULT NULL,
        latency_ms INT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        KEY idx_conversation (conversation_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    await db.query(`ALTER TABLE ai_messages MODIFY COLUMN content MEDIUMTEXT NOT NULL`).catch(() => {});
    await db.query(`ALTER TABLE ai_messages ADD COLUMN meta JSON DEFAULT NULL`).catch(() => {});
    await db.query(`ALTER TABLE ai_messages ADD COLUMN feedback TINYINT DEFAULT NULL`).catch(() => {});
    await db.query(`ALTER TABLE ai_messages ADD COLUMN latency_ms INT DEFAULT NULL`).catch(() => {});

    // 3. ai_settings 表与字段兼容升级
    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_settings (
        setting_key VARCHAR(50) PRIMARY KEY,
        setting_value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    await db.query(`ALTER TABLE ai_settings ADD COLUMN setting_key VARCHAR(50)`).catch(() => {});
    await db.query(`ALTER TABLE ai_settings ADD COLUMN setting_value TEXT`).catch(() => {});
    await db.query(`UPDATE ai_settings SET setting_key = \`key\`, setting_value = \`value\` WHERE setting_key IS NULL AND \`key\` IS NOT NULL`).catch(() => {});

    // 4. ai_documents 表与字段兼容升级
    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_documents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        filepath VARCHAR(500) NOT NULL,
        file_size INT DEFAULT 0,
        status VARCHAR(20) DEFAULT 'ready',
        vector_indexed TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    await db.query(`ALTER TABLE ai_documents ADD COLUMN filepath VARCHAR(500)`).catch(() => {});
    await db.query(`ALTER TABLE ai_documents ADD COLUMN file_size INT DEFAULT 0`).catch(() => {});
    await db.query(`ALTER TABLE ai_documents ADD COLUMN status VARCHAR(20) DEFAULT 'ready'`).catch(() => {});
    await db.query(`ALTER TABLE ai_documents ADD COLUMN vector_indexed TINYINT(1) DEFAULT 1`).catch(() => {});
    await db.query(`UPDATE ai_documents SET filepath = file_path WHERE filepath IS NULL AND file_path IS NOT NULL`).catch(() => {});

    console.log("--- 🚀 AI 数据库四张核心表 (ai_conversations / ai_messages / ai_settings / ai_documents) 兼容补全完毕 ---");
  } catch (error) {
    console.error("--- ⚠️ AI 数据库表自检失败:", error.message);
  }
}

module.exports = { ensureAiTables };
