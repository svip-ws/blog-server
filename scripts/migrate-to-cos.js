/**
 * 存量迁移：服务器本地 uploads → 腾讯云 COS（私有桶）
 * ------------------------------------------------------------------
 * 用法（在服务器后端目录，先确认 .env 已配 COS 且 STORAGE_DRIVER=cos）：
 *   node scripts/migrate-to-cos.js            # 预检 dry-run：只扫描、不上传不写库
 *   node scripts/migrate-to-cos.js --upload   # 仅把 uploads 文件上传到 COS（幂等，可重复）
 *   node scripts/migrate-to-cos.js --db       # 仅把各表文件字段 / 正文内嵌图更新为 key
 *   node scripts/migrate-to-cos.js --all      # 上传 + 更新库
 * 建议：先备份数据库 → --upload → 核对成功 → --db；任一步均可重复执行。
 */
const fs = require("fs");
const path = require("path");
const db = require("../config/db");
const { uploadBuffer, objectExists } = require("../utils/oss");
const { contentUrlsToKeys, urlToStoredKey, extractImgSrcs } = require("../utils/contentImages");

const APPLY_UPLOAD = process.argv.includes("--upload") || process.argv.includes("--all");
const APPLY_DB = process.argv.includes("--db") || process.argv.includes("--all");
const DRY = !APPLY_UPLOAD && !APPLY_DB;

const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");

// 覆盖核对：记录"数据库要转成 key、但 uploads 里找不到对应文件"的 key
const missingKeys = new Set();
const trackMissing = (key) => {
  if (key && !/^https?:\/\//i.test(key) && !fs.existsSync(path.join(UPLOADS_ROOT, key))) {
    missingKeys.add(key);
  }
};

const MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".glb": "model/gltf-binary", ".pdf": "application/pdf",
  ".json": "application/json", ".txt": "text/plain",
};
const mimeOf = (f) => MIME_BY_EXT[path.extname(f).toLowerCase()] || "application/octet-stream";

// 递归收集 uploads 下所有文件；key 统一用 / 分隔
function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const relDir = path.relative(UPLOADS_ROOT, full).split(path.sep).join("/");
      if (relDir === "snap/cards") continue; // 随拍制作工作目录（中间产物），不上传 COS
      out.push(...walk(full));
    } else if (ent.isFile()) {
      out.push({ full, key: path.relative(UPLOADS_ROOT, full).split(path.sep).join("/") });
    }
  }
  return out;
}

// 阶段 A：本地文件上传到 COS
async function migrateFiles() {
  if (!fs.existsSync(UPLOADS_ROOT)) {
    console.log("! uploads 目录不存在，跳过文件上传");
    return { uploaded: 0, skipped: 0, failed: 0 };
  }
  const files = walk(UPLOADS_ROOT);
  let uploaded = 0, skipped = 0, failed = 0;
  console.log(`\n=== 阶段 A：上传文件（${files.length} 个候选）===`);
  for (const { full, key } of files) {
    try {
      if (APPLY_UPLOAD) {
        if (await objectExists(key)) { skipped++; continue; } // 已存在，幂等跳过
        const buf = await fs.promises.readFile(full);
        await uploadBuffer(key, buf, mimeOf(key));
        uploaded++;
        if (uploaded % 25 === 0) console.log(`  ...已上传 ${uploaded}`);
      } else {
        uploaded++; // dry-run 仅计数
      }
    } catch (e) {
      failed++;
      console.log("  上传失败: " + key + " -> " + (e.message || e.code));
    }
  }
  console.log(APPLY_UPLOAD
    ? `文件阶段完成：新上传 ${uploaded}，已存在跳过 ${skipped}，失败 ${failed}`
    : `[dry-run] 将上传/核对 ${files.length} 个文件`);
  if (failed > 0) console.log("! 有失败项，修复后可重复执行（已上传对象会自动跳过）");
  return { uploaded, skipped, failed };
}

// 表 → 需更新为 key 的文件列（这些表主键均为 id）
const TABLE_COLUMNS = {
  article: ["cover"],
  user: ["avatar"],
  music: ["url", "cover"],
  snapshot_card: ["cover", "original_image", "thumbnail", "glb_path"],
  banner: ["media_url"],
  category: ["cover"],
  tag: ["cover"],
  message_wall: ["avatar", "image_url"],
  ai_documents: ["filepath", "file_path"],
};

// 阶段 B：各表文件字段 → key
async function migrateColumns() {
  console.log("\n=== 阶段 B：数据库文件字段 → key ===");
  let changed = 0, kept = 0;
  for (const [table, cols] of Object.entries(TABLE_COLUMNS)) {
    for (const col of cols) {
      let rows;
      try {
        [rows] = await db.query(
          `SELECT id, \`${col}\` AS v FROM \`${table}\`
           WHERE \`${col}\` IS NOT NULL AND \`${col}\` <> ''`);
      } catch (e) {
        console.log(`  跳过 ${table}.${col}（${e.code || e.message}）`);
        continue;
      }
      let colChanged = 0;
      for (const r of rows) {
        const nk = urlToStoredKey(String(r.v));
        if (nk === r.v) { kept++; continue; }
        changed++; colChanged++;
        trackMissing(nk);
        if (APPLY_DB) {
          await db.query(`UPDATE \`${table}\` SET \`${col}\` = ? WHERE id = ?`, [nk, r.id]);
        }
      }
      console.log(`  ${table}.${col}: ${rows.length} 行，${APPLY_DB ? "更新 " + colChanged : "待更新 " + colChanged}`);
    }
  }
  console.log(APPLY_DB
    ? `字段阶段完成：更新 ${changed} 行，本就为 key/外链保留 ${kept} 行`
    : `[dry-run] 将更新 ${changed} 行为 key，${kept} 行无需改动`);
}

// 阶段 C：文章正文内嵌图 → key
async function migrateContent() {
  console.log("\n=== 阶段 C：文章正文内嵌图 → key ===");
  const [rows] = await db.query(
    "SELECT id, content FROM article WHERE content IS NOT NULL AND content <> ''");
  let changed = 0;
  for (const r of rows) {
    const next = contentUrlsToKeys(r.content);
    if (next !== r.content) {
      changed++;
      extractImgSrcs(next).forEach(trackMissing);
      if (APPLY_DB) await db.query("UPDATE article SET content = ? WHERE id = ?", [next, r.id]);
    }
  }
  console.log(APPLY_DB
    ? `正文阶段完成：${changed} 篇正文内嵌图已转 key（共 ${rows.length} 篇）`
    : `[dry-run] 将更新 ${changed} 篇正文（共 ${rows.length} 篇）`);
}

// 预留/特殊字段：只报告，不自动改
async function reportReserved() {
  const [rows] = await db
    .query("SELECT COUNT(*) AS n FROM snapshot_card WHERE images IS NOT NULL AND TRIM(images) <> ''")
    .catch(() => [[{ n: 0 }]]);
  if (rows[0].n > 0) {
    console.log(`! 注意：snapshot_card.images 有 ${rows[0].n} 行（JSON 多图），脚本未自动处理，请人工确认`);
  }
}

(async () => {
  const mode = DRY
    ? "预检 dry-run（加 --upload / --db / --all 才会真正执行）"
    : APPLY_UPLOAD && APPLY_DB ? "--all（上传 + 更新库）"
    : APPLY_UPLOAD ? "--upload（仅上传文件）" : "--db（仅更新库）";
  console.log("存储迁移工具 · " + mode);
  await reportReserved();
  const f = await migrateFiles();
  await migrateColumns();
  await migrateContent();
  if (missingKeys.size > 0) {
    console.log(`\n! 文件缺失核对：${missingKeys.size} 个 key 在 uploads 中找不到文件：`);
    missingKeys.forEach((k) => console.log("   缺失 -> " + k));
    console.log("  这些记录转 key 后会裂图；请先从本地补齐这些文件、合并进 uploads 再 --upload。");
  } else {
    console.log("\n文件覆盖核对：待更新字段指向的文件在 uploads 中全部存在，可安全迁移。");
  }
  if (DRY) {
    console.log("\n预检完成：确认无误后，先执行 --upload，成功后再执行 --db。");
  } else {
    if (APPLY_UPLOAD && f.failed > 0) {
      console.log("\n! 文件上传存在失败项，建议先重跑 --upload 至 0 失败，再执行 --db。");
    } else {
      console.log("\n迁移流程结束。请重启后端（pm2 restart）并到前台核对图片 / 音频 / 封面。");
    }
  }
  process.exit(0);
})().catch((e) => { console.error("迁移异常:", e); process.exit(1); });
