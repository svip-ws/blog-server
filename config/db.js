const mysql = require("mysql2");
require("dotenv").config(); // 加载.env文件的配置到 process.env 中

// MySQL 连接池配置
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: "utf8mb4",
  timezone: "+08:00",
  waitForConnections: true, // 当连接池满了，后续请求是否等待
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 10, // 连接池最大连接数
  queueLimit: 0, // 排队请求无限制
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// 监听连接池底层异常，避免未捕获错误导致进程崩溃
pool.on("error", (err) => {
  console.error("❌ MySQL 连接池异常:", err);
});

// 导出 promise 版本的连接池，以便我们能够使用全新的 async/await 语法
module.exports = pool.promise();
