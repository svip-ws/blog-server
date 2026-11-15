// 音乐模块数据初始化脚本
// 用法（在能连到 blog_db 的机器上）：node scripts/setupMusic.js
// 幂等：表已存在则跳过建表；仅当表为空时写入种子数据。
// 同时被 blog-server/index.js 启动时调用（ensureMusicTable），实现本地开发零配置自举。

const db = require("../config/db");

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS music (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL DEFAULT '',
    artist VARCHAR(255) DEFAULT '',
    album VARCHAR(255) DEFAULT '',
    duration_sec INT DEFAULT 0,
    duration_str VARCHAR(20) DEFAULT '',
    cover VARCHAR(512) DEFAULT '',
    url VARCHAR(512) NOT NULL DEFAULT '',
    sort_order INT DEFAULT 0,
    is_active TINYINT DEFAULT 1,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const SEED = [
  ["甩葱歌 (Ievan Polkka)", "初音ミク", "Vocaloid Classic", 147, "02:27", "", "/uploads/music/shuaicong.mp3", 1, 1],
  ["千本桜 (Senbonzakura)", "初音ミク", "WhiteFlame", 244, "04:04", "", "/uploads/music/qianben.mp3", 2, 1],
  ["Tell Your World", "初音ミク", "Livetune", 257, "04:17", "", "/uploads/music/tell-your-world.mp3", 3, 1],
  ["メルト (Melt)", "初音ミク", "ryo (supercell)", 315, "05:15", "", "/uploads/music/melt.mp3", 4, 1],
];

async function ensureMusicTable() {
  await db.query(CREATE_SQL);
  const [rows] = await db.query("SELECT COUNT(*) AS cnt FROM music");
  if (rows[0].cnt === 0) {
    await db.query(
      `INSERT INTO music
        (title, artist, album, duration_sec, duration_str, cover, url, sort_order, is_active)
       VALUES ?`,
      [SEED]
    );
    console.log("--- ✅ music 表已初始化种子数据（4 首）");
  } else {
    console.log("--- ℹ️ music 表已存在，跳过种子写入");
  }
}

// 直接运行本脚本时执行
if (require.main === module) {
  ensureMusicTable()
    .then(() => {
      console.log("--- ✅ 音乐模块初始化完成");
      process.exit(0);
    })
    .catch((err) => {
      console.error("--- ❌ 音乐模块初始化失败（请确认数据库可连接）:", err.message);
      process.exit(1);
    });
}

module.exports = { ensureMusicTable };
