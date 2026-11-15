const sharp = require("sharp"), fs = require("fs"), path = require("path");
const pub = path.join(__dirname, "..", "..", "blog-client", "public");
const root = path.join(pub, "images");
const THRESH = 120 * 1024;

function walk(d) {
  let out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (/\.(jpe?g|png)$/i.test(e.name)) out.push(p);
  }
  return out;
}

(async () => {
  let before = 0, after = 0, n = 0;
  for (const f of walk(root)) {
    const stat = fs.statSync(f);
    if (stat.size <= THRESH) continue;
    const ext = path.extname(f).toLowerCase();
    let buf;
    if (ext === ".png") buf = await sharp(f).png({ quality: 82, compressionLevel: 9 }).toBuffer();
    else buf = await sharp(f).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
    if (buf.length < stat.size) {
      const tmp = f + ".tmp";
      try {
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, f); // 原子替换，规避直接写入被占用
        before += stat.size; after += buf.length; n++;
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        console.log("  跳过(被占用):", path.relative(root, f));
      }
    }
  }
  console.log(`压缩 ${n} 张：${(before / 1048576).toFixed(2)}MB → ${(after / 1048576).toFixed(2)}MB`);
})().catch((e) => { console.error(e); process.exit(1); });
