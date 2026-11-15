// 编辑精选（recommend_order）字段自举脚本
// 用法（在能连到 blog_db 的机器上）：node scripts/setupRecommend.js
// 幂等：若 article 表已存在 recommend_order 列则跳过；否则追加该列。
// 同时被 blog-server/index.js 启动时调用（ensureRecommendOrder），实现本地开发零配置自举。

const db = require("../config/db");

async function ensureRecommendOrder() {
  // 通过 information_schema 判断是否已存在该列，避免重复 ALTER 报错
  const [cols] = await db.query(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'article'
        AND COLUMN_NAME = 'recommend_order'`
  );

  if (cols.length > 0) {
    console.log("--- ℹ️ article.recommend_order 列已存在，跳过追加");
    return;
  }

  await db.query(
    `ALTER TABLE article
       ADD COLUMN recommend_order INT UNSIGNED NOT NULL DEFAULT 0
       COMMENT '编辑精选排序（越小越靠前，0 表示未参与排序）'`
  );
  console.log("--- ✅ article.recommend_order 列已追加");
}

// 直接运行本脚本时执行
if (require.main === module) {
  ensureRecommendOrder()
    .then(() => {
      console.log("--- ✅ 编辑精选字段初始化完成");
      process.exit(0);
    })
    .catch((err) => {
      console.error("--- ❌ 编辑精选字段初始化失败（请确认数据库可连接）:", err.message);
      process.exit(1);
    });
}

module.exports = { ensureRecommendOrder };
