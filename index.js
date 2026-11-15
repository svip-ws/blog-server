const express = require("express");
const cors = require("cors");
const compression = require("compression");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const db = require("./config/db");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

// 1. 设置代理信任（配合 Nginx 反向代理，必须最先设置）
app.set("trust proxy", 1);

// 2. 安全防护中间件
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // 允许图片/静态资源被前端跨域加载
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
      mediaSrc: ["'self'", "data:", "blob:", "https:", "http:"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["*"],
    },
  },
}));

// 3. GZIP 网页压缩中间件（性能高并发基石，排除 SSE 流式避免客户端缓冲假死；降低阈值到 256B 让小 JSON 也享高压缩比）
app.use(
  compression({
    threshold: 256,
    filter: (req, res) => {
      if (req.headers.accept && req.headers.accept.includes("text/event-stream")) {
        return false;
      }
      if (req.originalUrl && req.originalUrl.includes("/stream")) {
        return false;
      }
      return compression.filter(req, res);
    },
  })
);

// 3.5 公开只读聚合/目录 GET 接口轻量 HTTP 缓存（10s 强缓 + 30s 后台刷新，加速回退/切页）
const PUBLIC_CACHEABLE_API_RE = /^\/api\/(banner\/active|stats\/(summary|bootstrap)|category\/?$|tag\/?$|article\/(hot|latest|recommend)|comment\/latest|music\/playlist)$/;
app.use((req, res, next) => {
  if (req.method === "GET" && !req.headers.authorization && PUBLIC_CACHEABLE_API_RE.test(req.path)) {
    res.setHeader("Cache-Control", "public, max-age=10, stale-while-revalidate=30");
  }
  next();
});

// 4. 限流中间件（禁用针对 trustProxy 的过度严格校验，防止代理抛出 ValidationError 错误）
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 分钟
  max: 1000, // 限制每个 IP 每 15 分钟最多 1000 次请求
  validate: { trustProxy: false },
  message: { code: 429, message: "请求过于频繁，请稍后再试" }
});
app.use("/api/", generalLimiter);

// 针对敏感/重要接口配置限流
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  validate: { trustProxy: false },
  message: { code: 429, message: "操作过于频繁，请在15分钟后重试" }
});
app.use("/api/user/login", strictLimiter);
app.use("/api/user/register", strictLimiter);
app.use("/api/user/wx-login", strictLimiter);

// 文件上传类接口单独限流，防止盗刷存储与文档解析算力
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 分钟
  max: 30, // 每个 IP 每 15 分钟最多 30 次上传
  validate: { trustProxy: false },
  message: { code: 429, message: "上传操作过于频繁，请稍后再试" }
});
app.use("/api/ai/documents/upload", uploadLimiter);
app.use("/api/article/upload", uploadLimiter);
app.use("/api/music/upload", uploadLimiter);
app.use("/api/banner/upload", uploadLimiter);
app.post("/api/snapshot", uploadLimiter);
app.post("/api/snap/cards", uploadLimiter);
app.post("/api/user/avatar", uploadLimiter);

// 5. 基础中间件
// CORS 白名单：配置 CORS_ORIGINS（逗号分隔）后支持动态扩展来源；
// 默认始终放行 Capacitor / 移动端 App（https://localhost, http://localhost, capacitor://localhost）
const corsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const mobileAppOrigins = [
  "https://localhost",
  "http://localhost",
  "capacitor://localhost",
  "http://127.0.0.1",
  "https://127.0.0.1",
];

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      // 仅在非生产环境或原生 Capacitor WebView 源放行本地/局域网调试来源
      if (
        mobileAppOrigins.includes(origin) ||
        (process.env.NODE_ENV !== "production" &&
          (origin.startsWith("http://localhost:") ||
            origin.startsWith("https://localhost:") ||
            origin.startsWith("http://127.0.0.1:") ||
            origin.startsWith("http://192.168.")))
      ) {
        return cb(null, true);
      }
      // 显式配置的白名单
      if (corsOrigins.includes(origin)) {
        return cb(null, true);
      }
      // 未显式配置且为开发环境时放行全部
      if (corsOrigins.length === 0 && process.env.NODE_ENV !== "production") {
        return cb(null, true);
      }
      return cb(null, false);
    },
    credentials: true,
  })
);
// 请求体上限：默认 100KB 装不下长文富文本（正文是成段的 HTML 标签），
// 放宽到 2MB；图片仍走独立上传接口，不通过 body 传输。
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb", parameterLimit: 2000 }));

// 6. 路由加载
const userRoutes = require("./routes/userRoutes");
const categoryRoutes = require("./routes/categoryRoutes");
const articleRoutes = require("./routes/articleRoutes");
const commentRoutes = require("./routes/commentRoutes");
const tagRoutes = require("./routes/tagRoutes");
const archiveRoutes = require("./routes/archiveRoutes");
const bannerRoutes = require("./routes/bannerRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const snapshotRoutes = require("./routes/snapshotRoutes");
const musicRoutes = require("./routes/musicRoutes");
const statsRoutes = require("./routes/statsRoutes");
const messageRoutes = require("./routes/messageRoutes");

// 静态资源托管与兜底
const fs = require("fs");
// 资源缺失时返回本地占位图
function sendPlaceholder(res) {
  const placeholder = path.join(__dirname, "uploads", "placeholder.svg");
  fs.readFile(placeholder, (err, data) => {
    if (err) return res.status(404).end();
    res.set("Content-Type", "image/svg+xml");
    res.set("Cache-Control", "public, max-age=3600");
    return res.send(data);
  });
}
app.use("/uploads", express.static(path.join(__dirname, "uploads"), {
  maxAge: "7d",
  etag: true,
}));

app.use("/uploads", (req, res, next) => {
  const uploadsDir = path.join(__dirname, "uploads");
  const ext = path.extname(req.path);

  // 1. 尝试匹配不同扩展名的已有文件 (解决数据库存 .jpg 但磁盘文件是 .png 的命名错配)
  if (ext) {
    // 保留子目录路径并校验在 uploadsDir 内，防止路径穿越与丢失子目录
    const relPath = path.posix.normalize(req.path || "").replace(/^\/+/, "");
    if (relPath && !relPath.startsWith("..")) {
      const parsedRel = path.posix.parse(relPath);
      const relWithoutExt = path.posix.join(parsedRel.dir, parsedRel.name);
      const acceptsWebp = /image\/webp/i.test(req.headers.accept || "");
      const extOrder = [".png", ".jpg", ".jpeg", ".gif"];
      const candidates = acceptsWebp ? [".webp", ...extOrder] : [...extOrder];
      const possibleExts = candidates.filter((e) => e !== ext);
      for (const altExt of possibleExts) {
        const altPath = path.resolve(uploadsDir, relWithoutExt + altExt);
        if (!altPath.startsWith(path.resolve(uploadsDir) + path.sep)) continue;
        if (fs.existsSync(altPath)) {
          const mimeType = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
          }[altExt] || "application/octet-stream";
          return fs.readFile(altPath, (err, data) => {
            if (err) {
              console.error(`[uploads] 读取兜底文件失败: ${altPath}`, err.message);
              return sendPlaceholder(res);
            }
            res.set("Content-Type", mimeType);
            res.set("Cache-Control", "public, max-age=604800");
            return res.send(data);
          });
        }
      }
    }
  }

  // 2. 若文件确实已被彻底删除，返回本地占位图，防止页面出现 404 裂图（不依赖外部图床）
  return sendPlaceholder(res);
});


const aiRoutes = require("./routes/aiRoutes");

// 8. API 路由挂载
app.use("/api/user", userRoutes);
app.use("/api/category", categoryRoutes);
app.use("/api/article", articleRoutes);
app.use("/api/comment", commentRoutes);
app.use("/api/tag", tagRoutes);
app.use("/api/archive", archiveRoutes);
app.use("/api/banner", bannerRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/snapshot", snapshotRoutes);
app.use("/api/snap/cards", snapshotRoutes);
app.use("/api/music", musicRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/message", messageRoutes);
app.use("/api/ai", aiRoutes);

// 9. 根路由
app.get("/", (req, res) => {
  res.json({
    code: 200,
    message: "服务端已成功启动并保持运行",
    data: null,
  });
});

// 10. 全局错误捕获中间件（必须放在所有路由之后）
const errorHandler = require("./middlewares/errorHandler");
app.use(errorHandler);

// 测试数据库连接
async function checkDatabase() {
  try {
    const [rows] = await db.query("SELECT 1 + 1 AS result");
    console.log("--- 🚀 数据库连接成功！测试查询结果:", rows[0].result);
  } catch (error) {
    console.error("--- ❌ 数据库连接失败，请检查配置！");
    console.error(error.message);
    process.exit(1);
  }
}

checkDatabase();

// 数据库自检与表结构自动迁移（顺序幂等执行，防止多脚本并发 ALTER 导致死锁或锁表）
const { runAllMigrations } = require("./scripts/runMigrations");
runAllMigrations().catch((err) => {
  console.error("--- ❌ 数据库统一迁移执行异常:", err);
});

app.listen(PORT, () => {
  console.log(`--- 🌐 服务端已在端口 ${PORT} 成功架设 ---`);
  console.log(`--- ✅ AI服务版本: v2 (搜索缓存+防复读+查询归一化) ---`);
  console.log(`--- 📍 监听地址: http://localhost:${PORT} ---`);
});
