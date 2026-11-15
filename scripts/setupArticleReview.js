const db = require("../config/db");

/**
 * 文章审核体系字段自检（幂等）
 * -------------------------------------------------------------
 * 1. 补齐审核相关列：reject_reason / reviewed_by / reviewed_time
 * 2. 历史数据一致性：非法/缺失的 status 一律回落为「已发布」(1)，
 *    保证既有文章不因缺少状态字段而异常（旧数据本就走 status=1 可见）。
 */
async function ensureArticleReviewColumns() {
  const alters = [
    "ADD COLUMN reject_reason VARCHAR(500) DEFAULT NULL COMMENT '驳回原因'",
    "ADD COLUMN reviewed_by INT UNSIGNED DEFAULT NULL COMMENT '审核人 user_id'",
    "ADD COLUMN reviewed_time DATETIME DEFAULT NULL COMMENT '审核时间'",
  ];

  for (const alterSql of alters) {
    try {
      await db.query(`ALTER TABLE article ${alterSql}`);
      console.log(`--- ✅ article 已新增列: ${alterSql}`);
    } catch (e) {
      // 列已存在（ER_DUP_FIELDNAME）等情况直接跳过
    }
  }

  try {
    const [result] = await db.query(
      "UPDATE article SET status = 1 WHERE status IS NULL OR status NOT IN (0,1,2,3)",
    );
    if (result.affectedRows > 0) {
      console.log(`--- ✅ 已修正 ${result.affectedRows} 条历史文章状态为「已发布」`);
    }
  } catch (e) {
    console.error("--- ⚠️ 历史文章状态归一化失败:", e.message);
  }
}

module.exports = { ensureArticleReviewColumns };
