const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const pub = path.join(__dirname, "..", "..", "blog-client", "public");
const src = path.join(pub, "images", "logo.png");

(async () => {
  // 现代浏览器 PNG favicon（64x64，兼顾 retina，仍很小）
  await sharp(src).resize(64, 64).png({ quality: 90, compressionLevel: 9 })
    .toFile(path.join(pub, "favicon.png"));
  // iOS 主屏图标
  await sharp(src).resize(180, 180).png({ quality: 85 })
    .toFile(path.join(pub, "apple-touch-icon.png"));
  const kb = (f) => (fs.statSync(path.join(pub, f)).size / 1024).toFixed(1) + "KB";
  console.log("favicon.png:", kb("favicon.png"), " apple-touch-icon.png:", kb("apple-touch-icon.png"));
})().catch((e) => { console.error(e); process.exit(1); });
