const db = require("../config/db");

/**
 * 自动检测并补全 MySQL 高性能组合索引
 * 用于加速文章列表分页、分类/标签关联过滤、编辑精选推荐排序以及最新评论查询
 */
async function ensureIndexes() {
  try {
    const indexesToCreate = [
      {
        table: "article",
        indexName: "idx_article_status_create",
        cols: "(status, create_time DESC)",
      },
      {
        table: "article",
        indexName: "idx_article_status_category",
        cols: "(status, category_id)",
      },
      {
        table: "article",
        indexName: "idx_article_recommend",
        cols: "(status, is_recommend, recommend_order DESC)",
      },
      {
        table: "article_tag",
        indexName: "idx_article_tag_pair",
        cols: "(article_id, tag_id)",
      },
      {
        table: "comment",
        indexName: "idx_comment_article_status",
        cols: "(article_id, status, create_time DESC)",
      },
    ];

    for (const item of indexesToCreate) {
      try {
        const [existing] = await db.query(
          `SHOW INDEX FROM ${item.table} WHERE Key_name = ?`,
          [item.indexName]
        );
        if (!existing || existing.length === 0) {
          await db.query(
            `ALTER TABLE ${item.table} ADD INDEX ${item.indexName} ${item.cols}`
          );
          console.log(`--- ✅ 成功构建高效组合索引: ${item.table}.${item.indexName}`);
        }
      } catch (idxErr) {
        // 忽略单项创建容错警告
      }
    }
  } catch (error) {
    console.error("--- ⚠️ 数据库索引自检排查:", error.message);
  }
}

module.exports = { ensureIndexes };
