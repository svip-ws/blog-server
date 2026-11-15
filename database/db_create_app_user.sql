-- =============================================================
-- 专用数据库账号（替换 root 直连）
-- 背景：blog-server/.env 目前用 root + 8 位口令连接 MySQL。
--      一旦出现 SQL 注入或密钥泄露，root 权限意味着整库沦陷。
--      改为专用账号 + 最小权限，泄露面收敛到单个库的增删改查。
--
-- 使用方式（需 root 或有 CREATE USER 权限的账号执行一次）：
--   1. 把下面的 CHANGE_ME_STRONG_PASSWORD 换成你自己生成的强口令（建议 24 位以上随机串）
--   2. mysql -uroot -p < db_create_app_user.sql
--   3. 把同一口令写进 blog-server/.env 的 DB_USER / DB_PASSWORD
--   4. 重启后端：pm2 restart blog-server
--
-- 注意：本文件会进版本库，因此这里只放占位符，绝不写真实口令。
-- =============================================================

-- 1) 创建专用账号（仅允许从本机与应用服务器网段登录，按需收窄 % ）
CREATE USER IF NOT EXISTS 'blog_app'@'localhost'
  IDENTIFIED BY 'CHANGE_ME_STRONG_PASSWORD';

-- 若后端与数据库不在同一台机器，把上面改成实际来源，例如：
-- CREATE USER IF NOT EXISTS 'blog_app'@'10.0.0.%' IDENTIFIED BY 'CHANGE_ME_STRONG_PASSWORD';

-- 2) 最小授权：只给业务库的读写与建表权限（迁移脚本需要 CREATE/ALTER/INDEX）
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON `blog_db`.* TO 'blog_app'@'localhost';

-- 3) 明确不给这些能力（默认就没有，此处仅作说明，不需要执行）
--    GRANT ... ON *.*       → 跨库访问
--    FILE                   → 读写服务器任意文件
--    SUPER / PROCESS        → 查看他人会话、改全局参数
--    DROP                   → 误删整表的最后一道防线

FLUSH PRIVILEGES;

-- 4) 验证：用新账号登录并只读一次
--    mysql -ublog_app -p blog_db -e "SELECT COUNT(*) FROM article;"

-- 5) 全部验证通过后，再考虑把 root 的口令改掉或限制来源
--    ALTER USER 'root'@'localhost' IDENTIFIED BY 'CHANGE_ME_ROOT_PASSWORD';
