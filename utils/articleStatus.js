/**
 * 文章状态统一语义（与 `article.status` TINYINT 列对应）
 * -------------------------------------------------------------
 * 0 = 草稿     仅作者/管理员可见，可继续编辑
 * 1 = 已发布   对外公开可见
 * 2 = 待审核   普通用户提交后进入，等待管理员审核
 * 3 = 已驳回   管理员驳回，附带 reject_reason，作者可修改后重新提交(=2)
 */

const ARTICLE_STATUS = {
  DRAFT: 0,
  PUBLISHED: 1,
  PENDING: 2,
  REJECTED: 3,
};

const ARTICLE_STATUS_TEXT = {
  0: "草稿",
  1: "已发布",
  2: "待审核",
  3: "已驳回",
};

const ALL_STATUS = [0, 1, 2, 3];

const isValidStatus = (s) => ALL_STATUS.includes(Number(s));

module.exports = {
  ARTICLE_STATUS,
  ARTICLE_STATUS_TEXT,
  ALL_STATUS,
  isValidStatus,
};
