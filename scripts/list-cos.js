/**
 * 列出 COS 桶内全部对象（按顶层前缀分组），用于盘点存量
 * 用法：node scripts/list-cos.js
 */
require("dotenv").config();
const { cos, bucket, region } = require("../config/cos");

(async () => {
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

  console.log("桶 " + bucket + " 对象总数: " + all.length);

  const top = {};
  all.forEach((o) => {
    const k = o.Key.split("/")[0] || "(根)";
    (top[k] = top[k] || []).push(o);
  });
  Object.entries(top).forEach(([k, v]) => {
    console.log(`\n[${k}] ${v.length} 个`);
    v.slice(0, 60).forEach((o) => {
      console.log("   " + o.Key + "  (" + Math.round((o.Size || 0) / 1024) + " KB)");
    });
    if (v.length > 60) console.log("   ... 其余 " + (v.length - 60) + " 个省略");
  });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
