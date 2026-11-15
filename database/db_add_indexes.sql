-- =============================================================
-- 拾光笔记：为「已建好表」的本地 blog_db 补充高频读取覆盖索引
-- 生成时间：2026-09-10
-- 适用：MySQL 5.7+ / 8.0+
-- 说明：
--   1. 本脚本只针对已经建好表、但缺少下列索引的本地库，执行【一次】即可。
--   2. 全新库请直接使用 init.sql（其中已包含下列索引），无需再跑本脚本。
--   3. 索引均为新增（ADD INDEX），可随时 DROP INDEX 回滚，零数据风险。
-- 执行方式（在本地终端，blog-server/database 目录下）：
--   mysql -u<用户名> -p blog_db < db_add_indexes.sql
-- =============================================================

USE `blog_db`;

-- 文章：首页 / 推荐列表 WHERE status=? [AND is_recommend=?] ORDER BY create_time
ALTER TABLE `article`
  ADD INDEX `idx_status_recommend_create` (`status`, `is_recommend`, `create_time`);

-- 商品：热卖列表 WHERE status=? AND is_hot=? ORDER BY sort_order
--         + 新品列表 WHERE status=? AND is_new=? ORDER BY sort_order
ALTER TABLE `product`
  ADD INDEX `idx_status_hot` (`status`, `is_hot`, `sort_order`),
  ADD INDEX `idx_status_new` (`status`, `is_new`, `sort_order`);
