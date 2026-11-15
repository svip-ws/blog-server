const db = require("../config/db");

async function runAiMigration() {
  console.log("🚀 启动 AI 引擎与知识库数据表迁移脚本...");

  const queries = [
    `CREATE TABLE IF NOT EXISTS \`ai_conversations\` (
      \`id\` VARCHAR(36) NOT NULL PRIMARY KEY COMMENT '会话 UUID',
      \`user_id\` INT UNSIGNED DEFAULT NULL COMMENT '所属用户ID',
      \`title\` VARCHAR(255) NOT NULL DEFAULT '新对话' COMMENT '会话标题',
      \`system_prompt\` TEXT DEFAULT NULL COMMENT '自定义 System Prompt 指令',
      \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
      \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
      INDEX \`idx_ai_conv_user\` (\`user_id\`, \`updated_at\` DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI对话主表'`,

    `CREATE TABLE IF NOT EXISTS \`ai_messages\` (
      \`id\` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '消息自增ID',
      \`conversation_id\` VARCHAR(36) NOT NULL COMMENT '关联的会话 ID',
      \`role\` ENUM('user', 'model', 'system') NOT NULL COMMENT '发送角色',
      \`content\` MEDIUMTEXT NOT NULL COMMENT '消息文本内容',
      \`file_info\` JSON DEFAULT NULL COMMENT '文件或附件信息',
      \`feedback\` ENUM('like', 'dislike', 'none') DEFAULT 'none' COMMENT '消息点赞/踩反馈',
      \`latency_ms\` INT DEFAULT NULL COMMENT 'AI 生成延迟(毫秒)',
      \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '发送时间',
      INDEX \`idx_ai_msg_conv\` (\`conversation_id\`, \`created_at\` ASC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI对话消息明细表'`,

    `CREATE TABLE IF NOT EXISTS \`ai_settings\` (
      \`key\` VARCHAR(50) PRIMARY KEY COMMENT '配置键',
      \`value\` TEXT COMMENT '配置值',
      \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI全局配置表'`,

    `CREATE TABLE IF NOT EXISTS \`ai_documents\` (
      \`id\` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      \`filename\` VARCHAR(255) NOT NULL COMMENT '上传文档文件名',
      \`file_path\` VARCHAR(500) NOT NULL COMMENT '存储路径',
      \`chunk_count\` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '切片切块数',
      \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='RAG知识库文档表'`
  ];

  for (const q of queries) {
    await db.query(q);
  }

  console.log("✅ AI 数据库表结构初始化成功！");
  process.exit(0);
}

runAiMigration().catch((err) => {
  console.error("💥 AI 迁移脚本失败:", err);
  process.exit(1);
});
