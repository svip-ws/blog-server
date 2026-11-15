/**
 * COS 旧资源清理：删除 static/（旧版前端资源）与 uploads/（已迁移到新 key 的旧对象）
 * ------------------------------------------------------------------
 * 删除前会扫描数据库所有文件字段 / 正文 / 多图字段，确认没有任何地方还引用
 * 这些旧对象；仍被引用的对象会跳过、不删。
 * 用法：
 *   node scripts/cleanup-cos.js          # dry-run：列出待删对象 + 引用核对
 *   node scripts/cleanup-cos.js --apply  # 真正删除（删除前仍再核对一次引用）
 */
require("dotenv").config();
const db = require("../config/db");
const { cos, bucket, region } = require("../config/cos");

const APPLY = process.argv.includes("--apply");

// 需要扫描引用的 表 -> 文件列（含多图 images）
const TABLE_COLUMNS = {
  article: ["cover"],
  user: ["avatar"],
  music: ["url", "cover"],
  snapshot_card: ["cover", "original_image", "thumbnail", "glb_path", "images"],
  banner: ["media_url"],
  category: ["cover"],
  tag: ["cover"],
  message_wall: ["avatar", "image_url"],
  ai_documents: ["filepath", "file_path"],
};

// 收集数据库中所有可能引用文件的文本，拼成一个大字符串
async function collectReferenceText() {
  const parts = [];
  for (const [table, cols] of Object.entries(TABLE_COLUMNS)) {
    for (const col of cols) {
      try {
        const [rows] = await db.query(
          `SELECT \`${col}\` AS v FROM \`${table}\` WHERE \`${col}\` IS NOT NULL`
        );
        rows.forEach((r) => { if (r.v) parts.push(String(r.v)); });
      } catch (e) { /* 列/表不存在，跳过 */ }
    }
  }
  try {
    const [rows] = await db.query("SELECT content FROM article WHERE content IS NOT NULL");
    rows.forEach((r) => parts.push(String(r.content || "")));
  } catch (e) { /* ignore */ }
  return parts.join("\n");
}

async function listAll() {
  let marker;
  let all = [];
  do {
    const data = await new Promise((resolve, reject) => {
      cos.getBucket(
        { Bucket: bucket, Region: region, Marker: marker, MaxKeys: 1000 },
        (err, d) => (err ? reject(err) : resolve(d))
      );
    });
    all = all.concat(data.Contents || []);
    marker = data.IsTruncated === "true" ? data.NextMarker : null;
  } while (marker);
  return all.map((o) => o.Key);
}

// 对象可能以原始 key 或 URL 编码形式被引用
function isReferenced(key, refText) {
  const forms = [key, encodeURIComponent(key)].filter(Boolean);
  return forms.some((f) => refText.includes(f));
}

(async () => {
  console.log("COS 旧资源清理 · " + (APPLY ? "--apply（执行删除）" : "dry-run（加 --apply 才删除）"));
  const refText = await collectReferenceText();
  const keys = await listAll();
  const targets = keys.filter((k) => k.startsWith("static/") || k.startsWith("uploads/"));
  const safe = [];
  const referenced = [];
  for (const k of targets) {
    (isReferenced(k, refText) ? referenced : safe).push(k);
  }

  console.log(`\n待删候选 ${targets.length} 个：可安全删除 ${safe.length}，仍被引用 ${referenced.length}`);
  console.log("\n--- 可安全删除 ---");
  safe.forEach((k) => console.log("  " + k));
  if (referenced.length) {
    console.log("\n--- 仍被引用，跳过不删 ---");
    referenced.forEach((k) => console.log("  " + k));
  }

  if (APPLY) {
    if (referenced.length > 0) {
      console.log("\n! 存在仍被引用的对象，为安全起见本次不执行删除，请先处理引用。");
      process.exit(1);
    }
    // 批量删除，每批 500（deleteMultipleObject 上限 1000）
    for (let i = 0; i < safe.length; i += 500) {
      const batch = safe.slice(i, i + 500).map((Key) => ({ Key }));
      await new Promise((resolve, reject) => {
        cos.deleteMultipleObject(
          { Bucket: bucket, Region: region, Objects: batch },
          (err, data) => (err ? reject(err) : resolve(data))
        );
      });
      console.log(`  ...已删除 ${Math.min(i + 500, safe.length)}/${safe.length}`);
    }
    console.log("\n删除完成：已清理 " + safe.length + " 个旧对象。");
  } else {
    console.log("\n[dry-run] 确认上面清单无误、且「仍被引用」为 0 后，加 --apply 执行删除。");
  }
  process.exit(0);
})().catch((e) => { console.error("异常:", e); process.exit(1); });
