-- =============================================================
-- 拾光笔记（blog）数据库初始化脚本
-- -------------------------------------------------------------
-- 来源：由 blog-server/controllers 下的 SQL 语句逆向推断整理
-- 适用：MySQL 5.7+ / 8.0+
-- 说明：执行前请确认已备份。脚本会先建库再建表。
--       若生产库已存在，请只取 CREATE TABLE 部分比对后增量执行。
-- =============================================================

CREATE DATABASE IF NOT EXISTS `blog_db`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE `blog_db`;

SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------
-- 1. 用户表
-- ----------------------------
DROP TABLE IF EXISTS `user`;
CREATE TABLE `user` (
  `id`              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username`        VARCHAR(50)  NOT NULL COMMENT '登录账号',
  `password`        VARCHAR(255) NOT NULL COMMENT 'bcrypt 加密后的密码',
  `nickname`        VARCHAR(50)  DEFAULT NULL COMMENT '昵称',
  `avatar`          VARCHAR(255) DEFAULT NULL COMMENT '头像地址',
  `bio`             VARCHAR(500) DEFAULT NULL COMMENT '个人简介',
  `role`            ENUM('admin','user') NOT NULL DEFAULT 'user' COMMENT '角色：admin=管理员 user=普通用户',
  `status`          TINYINT NOT NULL DEFAULT 1 COMMENT '账号状态: 1=正常, 0=已禁用/冻结',
  `last_login_at`   DATETIME DEFAULT NULL COMMENT '最后登录时间',
  `last_login_ip`   VARCHAR(45) DEFAULT NULL COMMENT '最后登录IP',
  `openid`          VARCHAR(64)  DEFAULT NULL COMMENT '微信小程序唯一OpenID',
  `failed_attempts` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '连续登录失败次数',
  `lock_until`      DATETIME DEFAULT NULL COMMENT '账号锁定到期时间',
  `token_version`   INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Token版本号，改密或下线时自增',
  `points`          INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '积分余额（积分兑换商城消耗）',
  `create_time`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_username` (`username`),
  KEY `idx_openid` (`openid`),
  KEY `idx_status_role` (`status`, `role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户表';

-- ----------------------------
-- 2. 分类表
-- ----------------------------
DROP TABLE IF EXISTS `category`;
CREATE TABLE `category` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`        VARCHAR(50)  NOT NULL COMMENT '分类名称',
  `cover`       VARCHAR(500) DEFAULT NULL COMMENT '分类封面',
  `create_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='文章分类表';

-- ----------------------------
-- 3. 标签表
-- ----------------------------
DROP TABLE IF EXISTS `tag`;
CREATE TABLE `tag` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`        VARCHAR(50)  NOT NULL COMMENT '标签名称',
  `cover`       VARCHAR(500) DEFAULT NULL COMMENT '标签封面',
  `create_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='文章标签表';

-- ----------------------------
-- 4. 文章表
-- ----------------------------
DROP TABLE IF EXISTS `article`;
CREATE TABLE `article` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title`         VARCHAR(200) NOT NULL COMMENT '标题',
  `description`   VARCHAR(500) DEFAULT NULL COMMENT '摘要',
  `content`       LONGTEXT     COMMENT '正文（富文本 HTML）',
  `cover`         VARCHAR(255) DEFAULT NULL COMMENT '封面图',
  `category_id`   INT UNSIGNED DEFAULT NULL COMMENT '所属分类',
  `user_id`       INT UNSIGNED NOT NULL COMMENT '作者',
  `status`        TINYINT      NOT NULL DEFAULT 1 COMMENT '0=草稿 1=已发布 2=待审核 3=已驳回',
  `reject_reason` VARCHAR(500) DEFAULT NULL COMMENT '驳回原因（status=3 时由管理员填写）',
  `reviewed_by`   INT UNSIGNED DEFAULT NULL COMMENT '审核人 user_id',
  `reviewed_time` DATETIME     DEFAULT NULL COMMENT '审核时间',
  `is_recommend`  TINYINT      NOT NULL DEFAULT 0 COMMENT '是否推荐 0=否 1=是',
  `recommend_order` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '编辑精选排序（越小越靠前，0 表示未参与排序）',
  `view_count`    INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '浏览量',
  `like_count`    INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '点赞数',
  `comment_count` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '评论数',
  `create_time`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`),
  KEY `idx_category` (`category_id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_status` (`status`),
  KEY `idx_create_time` (`create_time`),
  KEY `idx_status_recommend_create` (`status`, `is_recommend`, `recommend_order`, `create_time`), -- 首页/推荐列表覆盖索引
  CONSTRAINT `fk_article_category` FOREIGN KEY (`category_id`) REFERENCES `category` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_article_user`     FOREIGN KEY (`user_id`)     REFERENCES `user` (`id`)     ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='文章表';

-- ----------------------------
-- 5. 文章-标签关联表
-- ----------------------------
DROP TABLE IF EXISTS `article_tag`;
CREATE TABLE `article_tag` (
  `article_id` INT UNSIGNED NOT NULL,
  `tag_id`     INT UNSIGNED NOT NULL,
  PRIMARY KEY (`article_id`, `tag_id`),
  KEY `idx_tag` (`tag_id`),
  CONSTRAINT `fk_at_article` FOREIGN KEY (`article_id`) REFERENCES `article` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_at_tag`     FOREIGN KEY (`tag_id`)     REFERENCES `tag` (`id`)     ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='文章标签关联表';

-- ----------------------------
-- 6. 评论表
-- ----------------------------
DROP TABLE IF EXISTS `comment`;
CREATE TABLE `comment` (
  `id`                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `article_id`         INT UNSIGNED NOT NULL COMMENT '所属文章',
  `user_id`            INT UNSIGNED DEFAULT NULL COMMENT '评论者（游客为 NULL）',
  `guest_name`         VARCHAR(64)  DEFAULT '热心网友' COMMENT '游客昵称',
  `guest_reply_to`     VARCHAR(64)  DEFAULT '' COMMENT '游客回复对象昵称',
  `parent_id`          INT UNSIGNED DEFAULT NULL COMMENT '父评论 ID，顶级为 NULL',
  `reply_to_user_id`   INT UNSIGNED DEFAULT NULL COMMENT '被回复者 ID',
  `reply_to_user_name` VARCHAR(50)  DEFAULT NULL COMMENT '被回复者昵称快照',
  `content`            TEXT         NOT NULL COMMENT '评论内容',
  `like_count`         INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '点赞数',
  `create_time`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_article` (`article_id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_parent` (`parent_id`),
  KEY `idx_create_time` (`create_time`),
  CONSTRAINT `fk_comment_article` FOREIGN KEY (`article_id`) REFERENCES `article` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_comment_user`    FOREIGN KEY (`user_id`)    REFERENCES `user` (`id`)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='文章评论表';

-- ----------------------------
-- 7. 文章点赞表
-- ----------------------------
DROP TABLE IF EXISTS `user_like`;
CREATE TABLE `user_like` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     INT UNSIGNED NOT NULL,
  `article_id`  INT UNSIGNED NOT NULL,
  `create_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_article` (`user_id`, `article_id`),
  KEY `idx_article` (`article_id`),
  CONSTRAINT `fk_like_user`    FOREIGN KEY (`user_id`)    REFERENCES `user` (`id`)    ON DELETE CASCADE,
  CONSTRAINT `fk_like_article` FOREIGN KEY (`article_id`) REFERENCES `article` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='文章点赞表';

-- ----------------------------
-- 8. 轮播图表
-- ----------------------------
DROP TABLE IF EXISTS `banner`;
CREATE TABLE `banner` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title`       VARCHAR(100) NOT NULL COMMENT '主标题',
  `subtitle`    VARCHAR(200) DEFAULT NULL COMMENT '副标题',
  `media_url`   VARCHAR(255) NOT NULL COMMENT '图片或视频地址',
  `media_type`  VARCHAR(20)  NOT NULL DEFAULT 'image' COMMENT 'image / video',
  `link`        VARCHAR(255) DEFAULT NULL COMMENT '跳转链接',
  `sort_order`  INT          NOT NULL DEFAULT 0 COMMENT '排序，越小越靠前',
  `status`      TINYINT      NOT NULL DEFAULT 1 COMMENT '0=下架 1=启用',
  `create_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_status` (`status`),
  KEY `idx_sort` (`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='首页轮播图表';


-- ----------------------------
-- 12. 随拍 3D 镭射卡片表
-- ----------------------------
DROP TABLE IF EXISTS `snapshot_card`;
CREATE TABLE `snapshot_card` (
  `id`                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `card_no`            VARCHAR(50)  NOT NULL COMMENT '卡片编号（如 No.001）',
  `name`               VARCHAR(200) NOT NULL COMMENT '卡片名称',
  `category`           VARCHAR(50)  DEFAULT '生活' COMMENT '所属分类（风景/人物/生活/宠物等）',
  `style_preset`       VARCHAR(50)  DEFAULT '赛博朋克' COMMENT '风格预设（赛博朋克/水墨风/复古胶片等）',
  `description`        TEXT         COMMENT '简短描述',
  `cover`              VARCHAR(255) DEFAULT NULL COMMENT '主缩略图/原图',
  `images`             TEXT         COMMENT '多层分层图集/相关图，JSON 数组',
  `parallax_intensity` DECIMAL(3,2) NOT NULL DEFAULT 0.85 COMMENT '视差强度',
  `is_published`       TINYINT      NOT NULL DEFAULT 1 COMMENT '0=草稿 1=已发布',
  `sort_order`         INT          NOT NULL DEFAULT 0 COMMENT '排序',
  `view_count`         INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '浏览量',
  `like_count`         INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '点赞数',
  `config_json`        TEXT         COMMENT '自动生成的 3D Holo 配置文件 JSON',
  `create_time`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_published` (`is_published`),
  KEY `idx_category` (`category`),
  KEY `idx_sort` (`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='随拍 3D 镭射卡片表';

-- ----------------------------
-- 13. 随拍点赞表
-- ----------------------------
DROP TABLE IF EXISTS `snapshot_like`;
CREATE TABLE `snapshot_like` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `snapshot_id` INT UNSIGNED NOT NULL,
  `user_id`     INT UNSIGNED DEFAULT NULL,
  `ip`          VARCHAR(64)  DEFAULT NULL,
  `create_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_snap_user` (`snapshot_id`, `user_id`),
  KEY `idx_snap_ip`   (`snapshot_id`, `ip`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='随拍点赞记录表';

-- ----------------------------
-- 14. 评论点赞表
-- ----------------------------
DROP TABLE IF EXISTS `comment_like`;
CREATE TABLE `comment_like` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `comment_id`  INT UNSIGNED NOT NULL,
  `user_id`     INT UNSIGNED DEFAULT NULL,
  `ip`          VARCHAR(64)  DEFAULT NULL,
  `create_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_comment_user` (`comment_id`, `user_id`),
  KEY `idx_comment_ip`   (`comment_id`, `ip`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='评论点赞记录表';

-- ----------------------------
-- 15. 留言点赞表
-- ----------------------------
DROP TABLE IF EXISTS `message_like`;
CREATE TABLE `message_like` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `message_id`  INT UNSIGNED NOT NULL,
  `user_id`     INT UNSIGNED DEFAULT NULL,
  `ip`          VARCHAR(64)  DEFAULT NULL,
  `create_time` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_message_user` (`message_id`, `user_id`),
  KEY `idx_message_ip`   (`message_id`, `ip`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='留言点赞记录表';

SET FOREIGN_KEY_CHECKS = 1;

-- ----------------------------
-- 初始数据
-- ----------------------------

-- 说明：管理员账号需通过注册接口创建后再手动提升权限，
--      例如：UPDATE `user` SET `role` = 'admin' WHERE `username` = '你的账号';
