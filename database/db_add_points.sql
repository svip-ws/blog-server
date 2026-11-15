-- =============================================================
-- 积分兑换：为已有 blog_db 追加字段（仅供已存在的本地库一次性执行）
-- -------------------------------------------------------------
-- 说明：
--   1. 全新库直接跑 init.sql 即可，无需本文件。
--   2. 本文件幂等安全：字段已存在时 ALTER 会报错，跳过即可。
--   3. 兑换规则：1 元 = 1 积分（订单 total_amount 向上取整），
--      由后端 redeemOrder 计算并扣除，无需前端传积分。
-- =============================================================

USE `blog_db`;

-- 用户积分余额
ALTER TABLE `user`
  ADD COLUMN `points` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '积分余额（积分兑换商城消耗）'
  AFTER `role`;

-- 订单支付方式 + 兑换消耗积分
ALTER TABLE `order`
  ADD COLUMN `pay_type` TINYINT NOT NULL DEFAULT 1 COMMENT '支付方式 1=积分兑换'
  AFTER `status`;

ALTER TABLE `order`
  ADD COLUMN `points_cost` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '兑换消耗的积分（pay_type=1 时有效）'
  AFTER `pay_type`;

-- -------------------------------------------------------------
-- 【可选】本地测试：给你的测试账号发一笔积分，便于跑通兑换流程。
-- 把下面 username 换成你本地注册的账号，取消注释后执行一次即可。
--   新注册用户默认 0 积分，不发放则兑换会提示「积分不足」。
-- -------------------------------------------------------------
-- UPDATE `user` SET `points` = 100000 WHERE `username` = '你的测试账号';
