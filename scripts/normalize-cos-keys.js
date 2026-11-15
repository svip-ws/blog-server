/**
 * COS 对象 key 归一化：把旧的 uploads/<key> 服务端复制为 <key>
 * ------------------------------------------------------------------
 * 背景：最早版本把文件传到 COS 的 uploads/ 路径；新代码签名时会剥掉 uploads/
 *      前缀，需要让同一对象在新 key 下也存在。
 * 用法：
 *   node scripts/normalize-cos-keys.js          # dry-run，只列出将复制的对象
 *   node scripts/normalize-cos-keys.js --apply  # 真正执行服务端复制（幂等）
 * 说明：copyObject 为同桶同地域服务端复制，不走本地带宽、免费、秒完成。
 */
require("dotenv").config();
const { cos, bucket, region } = require("../config/cos");
const { objectExists, copyObjectKey } = require("../utils/oss");

const APPLY = process.argv.includes("--apply");

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

(async () => {
  console.log("COS key 归一化 · " + (APPLY ? "--apply（执行复制）" : "dry-run（加 --apply 才真正复制）"));
  const keys = await listAll();
  const targets = keys.filter((k) => k.startsWith("uploads/") && k !== "uploads/");
  let copied = 0, skipped = 0, failed = 0;
  console.log(`\n发现 ${targets.length} 个 uploads/ 前缀对象待归一化`);
  for (const src of targets) {
    const dest = src.slice("uploads/".length);
    if (!dest) continue;
    try {
      if (await objectExists(dest)) { skipped++; continue; }
      if (APPLY) await copyObjectKey(src, dest);
      copied++;
      console.log("  " + src + "  ->  " + dest);
    } catch (e) {
      failed++;
      console.log("  复制失败: " + src + " -> " + (e.message || e.code));
    }
  }
  console.log(APPLY
    ? `\n归一化完成：新复制 ${copied}，已存在跳过 ${skipped}，失败 ${failed}`
    : `\n[dry-run] 将复制 ${copied} 个，已存在跳过 ${skipped}`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error("异常:", e); process.exit(1); });
