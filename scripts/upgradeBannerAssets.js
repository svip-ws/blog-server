/**
 * 首页轮播图资源升级（幂等 · 本地维护脚本）
 * -------------------------------------------------------------
 * 背景：线上轮播图原图仅 1276×850 / 1280×720 / 1792×1024，
 *       在 100vh 全屏下被浏览器放大约 1.5×，导致「清晰度不足」。
 * 做法：
 *   1. 为每张图片型轮播图生成 <同名>-hero.webp（宽 2560，Lanczos3 + 轻锐化）
 *      —— 让 1080p/1440p 屏改为「降采样」而非「放大」，从根上提升清晰度；
 *   2. 生成 <同名>-thumb.webp（宽 480）供右下角精选挂件的缩略图使用，
 *      避免缩略图去下载全尺寸大图；
 *   3. 将 banner.media_url 指向 hero 版本（保留原 host 前缀与目录）。
 *
 * 幂等：hero 已存在则跳过重采样；media_url 已指向 -hero.webp 则不再改写。
 * 说明：仅处理 media_type='image' 且本地文件存在的记录，其余原样保留。
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

// 先按绝对路径加载 .env，再引入 db（避免依赖 cwd 导致 env 缺失）
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const db = require("../config/db");

const UPLOAD_DIR = path.join(__dirname, "../uploads");
const HERO_WIDTH = 2560;
const THUMB_WIDTH = 480;

// 本地文件名 ↔ 磁盘路径（media_url 为 http(s)://host/uploads/xxx.jpg 绝对地址）
function localPathOf(mediaUrl) {
  if (!mediaUrl) return null;
  const m = mediaUrl.split("?")[0].match(/\/uploads\/([^/]+)$/);
  if (!m) return null;
  return path.join(UPLOAD_DIR, m[1]);
}

// 用给定 base 名替换 media_url 的文件名部分（保留 host + /uploads 前缀）
function withFilename(mediaUrl, filename) {
  const m = mediaUrl.split("?")[0].match(/\/uploads\/([^/]+)$/);
  if (!m) return mediaUrl;
  return mediaUrl.slice(0, mediaUrl.length - m[1].length) + filename;
}

// 缩略图与英雄图的文件名约定：<base>.jpg → <base>-hero.webp / <base>-thumb.webp
function heroNameOf(filename) {
  return filename.replace(/\.[^.]+$/, "") + "-hero.webp";
}
function thumbNameOf(filename) {
  return filename.replace(/\.[^.]+$/, "") + "-thumb.webp";
}

async function buildVariants(srcPath, baseName) {
  const heroPath = path.join(UPLOAD_DIR, heroNameOf(baseName));
  const thumbPath = path.join(UPLOAD_DIR, thumbNameOf(baseName));

  const buf = fs.readFileSync(srcPath);

  let heroMade = false;
  if (!fs.existsSync(heroPath)) {
    await sharp(buf)
      .resize({ width: HERO_WIDTH, kernel: "lanczos3", fit: "inside", withoutEnlargement: false })
      .sharpen({ sigma: 0.8, m1: 0.6, m2: 1.8 })
      .webp({ quality: 82, effort: 5 })
      .toFile(heroPath);
    heroMade = true;
  }

  let thumbMade = false;
  if (!fs.existsSync(thumbPath)) {
    await sharp(buf)
      .resize({ width: THUMB_WIDTH, kernel: "lanczos3", fit: "inside" })
      .webp({ quality: 78, effort: 4 })
      .toFile(thumbPath);
    thumbMade = true;
  }

  return { heroPath, thumbPath, heroMade, thumbMade };
}

async function upgradeBannerAssets() {
  // 自检列存在（无 thumb_url 列时也不影响，前端按约定推导缩略图）
  const [banners] = await db.query(
    "SELECT id, media_url, media_type FROM banner WHERE media_type = 'image'",
  );

  let processed = 0;
  for (const b of banners) {
    if (!b.media_url || /-hero\.webp($|\?)/.test(b.media_url)) continue; // 已升级，跳过
    const srcPath = localPathOf(b.media_url);
    if (!srcPath || !fs.existsSync(srcPath)) continue; // 非本地 uploads 文件，跳过

    const baseName = path.basename(srcPath);
    try {
      const { heroPath, thumbPath, heroMade, thumbMade } = await buildVariants(srcPath, baseName);

      const heroSize = fs.statSync(heroPath).size;
      const thumbSize = fs.statSync(thumbPath).size;

      // 仅在 hero 为已生成/已存在时改写 media_url
      const newUrl = withFilename(b.media_url, heroNameOf(baseName));
      if (newUrl !== b.media_url) {
        await db.query("UPDATE banner SET media_url = ? WHERE id = ?", [newUrl, b.id]);
      }

      processed++;
      console.log(
        `  ✔ banner#${b.id} ${baseName} → ${path.basename(heroPath)} (${Math.round(heroSize / 1024)}KB)` +
        `${heroMade ? " [新]" : " [已存在]"}` +
        ` | thumb ${path.basename(thumbPath)} (${Math.round(thumbSize / 1024)}KB)${thumbMade ? " [新]" : " [已存在]"}`,
      );
    } catch (err) {
      console.error(`  ✖ banner#${b.id} 处理失败（已跳过）:`, err.message);
    }
  }

  console.log(`--- 轮播图资源升级完成：处理 ${processed} 张`);
  return processed;
}

module.exports = { upgradeBannerAssets, heroNameOf, thumbNameOf, withFilename };

// 允许 `node scripts/upgradeBannerAssets.js` 直接执行
if (require.main === module) {
  require("dotenv").config({ path: path.join(__dirname, "../.env") });
  upgradeBannerAssets()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("轮播图资源升级失败:", err);
      process.exit(1);
    });
}
