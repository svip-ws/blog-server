/**
 * 批量把 uploads 下的传统图片（jpg/jpeg/png）转成同名 WebP
 * ----------------------------------------------------------------
 * 用途：在不删原图的前提下，为旧资源附加现代格式版本。
 *       blog-server/index.js 的 /uploads 降级逻辑已优先返回 .webp，
 *       因此转换后所有旧封面/头像/消息配图会自动以 WebP 下发，体积显著下降。
 * 安全：
 *   - 保留原图，仅新增 .webp，不破坏任何现有引用
 *   - 排除 snap/ 目录（快照 3D 模型依赖固定 .jpg 输入，不转换）
 *   - 已存在同名 .webp 则跳过
 * 运行：node scripts/convertUploadsToWebp.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const UPLOAD_DIR = path.join(__dirname, '../uploads');
const EXCLUDE_DIRS = new Set(['snap']); // 快照专用图，引用固定，不转换
const SRC_EXTS = ['.jpg', '.jpeg', '.png'];

function walk(dir, cb) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(full, cb);
    } else {
      cb(full);
    }
  }
}

async function main() {
  const targets = [];
  walk(UPLOAD_DIR, (f) => {
    const ext = path.extname(f).toLowerCase();
    if (SRC_EXTS.includes(ext)) targets.push(f);
  });

  let converted = 0;
  let skipped = 0;
  let failed = 0;

  for (const f of targets) {
    const webp = f.slice(0, -path.extname(f).length) + '.webp';
    if (fs.existsSync(webp)) {
      skipped++;
      continue;
    }
    try {
      await sharp(f).webp({ quality: 82 }).toFile(webp);
      converted++;
      console.log('✓', path.relative(UPLOAD_DIR, f), '→', path.relative(UPLOAD_DIR, webp));
    } catch (e) {
      failed++;
      console.error('✗ 失败', f, e.message);
    }
  }

  console.log(`\n完成：转换 ${converted} 张，跳过已存在 ${skipped} 张，失败 ${failed} 张`);
}

main();
