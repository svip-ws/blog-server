/**
 * 文章热度计算集中配置文件
 * 集中管理各热度维度的计算权重，便于后续调整与维护。
 */
const HEAT_CONFIG = {
  // 热度维度权重定义
  weights: {
    view_count: 1,     // 浏览量权重
    like_count: 5,     // 点赞数权重
    comment_count: 10,  // 评论数权重
  },
  // 默认排序模式
  defaultSort: 'latest',
  // 支持的合法排序类型
  allowedSorts: ['latest', 'hot'],
};

/**
 * 生成用于 SQL ORDER BY 的热度得分计算表达式
 * @param {string} alias - 数据库表别名，默认为 'a'
 * @returns {string} SQL 算式表达式，如 (a.view_count * 1 + a.like_count * 5 + a.comment_count * 10)
 */
const getHeatSqlExpression = (alias = 'a') => {
  const { view_count, like_count, comment_count } = HEAT_CONFIG.weights;
  return `(${alias}.view_count * ${view_count} + ${alias}.like_count * ${like_count} + ${alias}.comment_count * ${comment_count})`;
};

module.exports = {
  HEAT_CONFIG,
  getHeatSqlExpression,
};
