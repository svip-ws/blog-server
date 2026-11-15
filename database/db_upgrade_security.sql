-- =============================================================
-- 拾光笔记 (blog) 数据库全栈安全与审计增量升级脚本
-- -------------------------------------------------------------
-- 功能：安全增加 status, last_login_at, last_login_ip, failed_attempts
-- 适用：MySQL 5.7+ / 8.0+
-- =============================================================

ALTER TABLE `user` 
  ADD COLUMN IF NOT EXISTS `status` TINYINT NOT NULL DEFAULT 1 COMMENT '账号状态: 1=正常, 0=已禁用/冻结' AFTER `role`,
  ADD COLUMN IF NOT EXISTS `last_login_at` DATETIME DEFAULT NULL COMMENT '最后登录时间' AFTER `status`,
  ADD COLUMN IF NOT EXISTS `last_login_ip` VARCHAR(45) DEFAULT NULL COMMENT '最后登录IP地址' AFTER `last_login_at`,
  ADD COLUMN IF NOT EXISTS `failed_attempts` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '连续登录失败次数' AFTER `last_login_ip`;

-- 为账号状态与角色建立复合索引加速检索
ALTER TABLE `user` ADD INDEX `idx_status_role` (`status`, `role`);
