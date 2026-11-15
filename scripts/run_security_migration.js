const db = require("../config/db");

async function runMigration() {
  console.log("🚀 启动数据库安全与审计结构升级脚本...");

  const addColumn = async (columnName, sqlDef) => {
    try {
      const [columns] = await db.query(
        `SHOW COLUMNS FROM user LIKE ?`,
        [columnName]
      );
      if (columns.length === 0) {
        console.log(`➕ 正在添加字段 \`user\`.\`${columnName}\`...`);
        await db.query(`ALTER TABLE \`user\` ADD COLUMN \`${columnName}\` ${sqlDef}`);
        console.log(`✅ 字段 \`${columnName}\` 添加成功`);
      } else {
        console.log(`ℹ️ 字段 \`${columnName}\` 已存在，跳过`);
      }
    } catch (err) {
      console.error(`❌ 添加字段 \`${columnName}\` 失败:`, err.message);
    }
  };

  await addColumn("status", "TINYINT NOT NULL DEFAULT 1 COMMENT '账号状态: 1=正常, 0=已禁用/冻结'");
  await addColumn("last_login_at", "DATETIME DEFAULT NULL COMMENT '最后登录时间'");
  await addColumn("last_login_ip", "VARCHAR(45) DEFAULT NULL COMMENT '最后登录IP'");
  await addColumn("failed_attempts", "INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '连续失败次数'");

  // 尝试添加索引
  try {
    const [indexes] = await db.query("SHOW INDEX FROM user WHERE Key_name = 'idx_status_role'");
    if (indexes.length === 0) {
      console.log("➕ 正在创建索引 \`idx_status_role\`...");
      await db.query("ALTER TABLE \`user\` ADD INDEX \`idx_status_role\` (\`status\`, \`role\`)");
      console.log("✅ 索引创建成功");
    }
  } catch (err) {
    console.error("❌ 索引创建提示:", err.message);
  }

  console.log("🎉 数据库升级完毕！");
  process.exit(0);
}

runMigration().catch((err) => {
  console.error("💥 升级脚本失败:", err);
  process.exit(1);
});
