-- =============================================================
-- 拾光笔记 (blog) AI 会话游客归属字段迁移
-- 目的：解决「游客(未登录)历史对话始终为空」的问题
-- 说明：原 ai_conversations 仅有 user_id，游客会话 user_id=NULL 且无归属标识，
--       getConversations 对游客直接返回 []，导致历史永远查不到。
--       新增 guest_id 绑定浏览器设备 UUID，使游客会话可持久化并回查。
--
-- 执行方式（在 blog_db 上运行一次）：
--   mysql -u<user> -p blog_db < db_add_ai_guest.sql
-- 或使用任意 MySQL 客户端执行本文件内容。
-- =============================================================

ALTER TABLE `ai_conversations`
  ADD COLUMN `guest_id` VARCHAR(36) DEFAULT NULL
    COMMENT '游客设备UUID(未登录时用于归属与回查会话)' AFTER `user_id`,
  ADD INDEX `idx_ai_conv_guest` (`guest_id`, `updated_at` DESC);
