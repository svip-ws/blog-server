// 留言墙模块数据初始化脚本
// 幂等：表已存在则跳过建表；被 blog-server/index.js 启动时调用，实现本地开发零配置自举。

const db = require("../config/db");

const CREATE_MESSAGE_WALL_SQL = `
  CREATE TABLE IF NOT EXISTS message_wall (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nickname VARCHAR(64) NOT NULL DEFAULT '初音骑士39号',
    content TEXT NOT NULL,
    avatar VARCHAR(255) DEFAULT '',
    image_url VARCHAR(255) DEFAULT '',
    likes INT UNSIGNED NOT NULL DEFAULT 0,
    is_featured TINYINT NOT NULL DEFAULT 0 COMMENT '0=普通 1=精选置顶',
    status TINYINT NOT NULL DEFAULT 1 COMMENT '0=已下架 1=展示中',
    user_id INT UNSIGNED DEFAULT NULL,
    create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_status_create (status, create_time),
    KEY idx_featured (is_featured, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const CREATE_MESSAGE_REPLY_SQL = `
  CREATE TABLE IF NOT EXISTS message_reply (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id INT UNSIGNED NOT NULL,
    nickname VARCHAR(64) NOT NULL DEFAULT '初音骑士',
    content TEXT NOT NULL,
    user_id INT UNSIGNED DEFAULT NULL,
    create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_message_id (message_id),
    CONSTRAINT fk_reply_message FOREIGN KEY (message_id) REFERENCES message_wall(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const CREATE_MESSAGE_LIKE_SQL = `
  CREATE TABLE IF NOT EXISTS message_like (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    message_id INT UNSIGNED NOT NULL,
    user_id INT UNSIGNED DEFAULT NULL,
    ip VARCHAR(64) DEFAULT NULL,
    create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_message_user (message_id, user_id),
    KEY idx_message_ip (message_id, ip)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const SEED_MESSAGES = [
  ["初音骑士39号", "39 是 Thank You 的意思，也是永远喜欢你的意思。", "", "", 39, 1, 1, null],
  ["未来快递员", "想把全世界的葱绿色邮筒都涂成你的颜色。", "", "", 39, 1, 1, null],
  ["舞台下的星屑", "每次听到你的声音，就像被月光洗了一遍。", "", "", 39, 1, 1, null],
];

// 留言点赞表：新建即含 ip；旧库缺 ip 列/索引时幂等补齐（游客按 IP 去重）
async function ensureMessageLikeTable() {
  await db.query(CREATE_MESSAGE_LIKE_SQL);
  const [cols] = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'message_like' AND COLUMN_NAME = 'ip'",
    [process.env.DB_NAME]
  );
  if (cols.length === 0) {
    await db.query("ALTER TABLE message_like ADD COLUMN ip VARCHAR(64) DEFAULT NULL AFTER user_id");
    console.log("--- ✅ message_like.ip 列已补齐");
  }
  const [idx] = await db.query(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'message_like' AND INDEX_NAME = 'idx_message_ip'",
    [process.env.DB_NAME]
  );
  if (idx.length === 0) {
    await db.query("ALTER TABLE message_like ADD KEY idx_message_ip (message_id, ip)");
    console.log("--- ✅ message_like idx_message_ip 索引已补齐");
  }
}

async function ensureMessageWallTables() {
  await db.query(CREATE_MESSAGE_WALL_SQL);
  await db.query(CREATE_MESSAGE_REPLY_SQL);
  await ensureMessageLikeTable();

  const [rows] = await db.query("SELECT COUNT(*) AS cnt FROM message_wall");
  if (rows[0].cnt === 0) {
    await db.query(
      `INSERT INTO message_wall
        (nickname, content, avatar, image_url, likes, is_featured, status, user_id)
       VALUES ?`,
      [SEED_MESSAGES]
    );
    console.log("--- ✅ message_wall 已初始化种子留言（3 条）");
  } else {
    console.log("--- ℹ️ message_wall 已存在，跳过种子写入");
  }
}

if (require.main === module) {
  ensureMessageWallTables()
    .then(() => {
      console.log("--- ✅ 留言墙表初始化完成");
      process.exit(0);
    })
    .catch((err) => {
      console.error("--- ❌ 留言墙表初始化失败（请确认数据库可连接）:", err.message);
      process.exit(1);
    });
}

module.exports = { ensureMessageWallTables };
