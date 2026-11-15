/**
 * 角色与权限统一工具
 * -------------------------------------------------------------
 * 线上库 `user.role` 为 enum('admin','user')，但历史代码中散落着
 * `role !== 'admin'`、`WHERE role = 'admin'` 等字样，且早期 init.sql
 * 曾误写为 TINYINT。这里收敛为唯一权威判定，避免各处各判一套导致越权。
 */

const ROLE_ADMIN = "admin";
const ROLE_USER = "user";

/** 是否为管理员：兼容 'admin' / 1 / '1' 三种历史写法 */
const isAdmin = (role) =>
  role === ROLE_ADMIN || role === 1 || role === "1";

/** 归一化为规范角色字符串，未知值一律回落为普通用户 */
const normalizeRole = (role) => (isAdmin(role) ? ROLE_ADMIN : ROLE_USER);

module.exports = { ROLE_ADMIN, ROLE_USER, isAdmin, normalizeRole };
