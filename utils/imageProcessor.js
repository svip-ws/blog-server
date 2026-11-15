const path = require("path");
const sharp = require("sharp");
const storage = require("../services/storage");

/**
 * 校验并处理上传图片：
 * - GIF / WebP：通过 sharp.metadata() 验证真实图片魔数与格式，拒绝伪造扩展名载荷
 * - JPG / PNG 等：统一转为质量 80 的 WebP 压缩图
 */
async function processAndStoreImage(file, dir) {
  if (!file || !file.buffer) {
    const err = new Error("无效的图片文件");
    err.status = 400;
    throw err;
  }

  const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
  const origExt = path.extname(file.originalname || "").toLowerCase();
  const isGif = file.mimetype === "image/gif" || origExt === ".gif";
  const isWebp = file.mimetype === "image/webp" || origExt === ".webp";

  let buffer = file.buffer;
  let filename;
  let mime;

  if (isGif || isWebp) {
    let meta;
    try {
      meta = await sharp(file.buffer).metadata();
    } catch {
      const err = new Error("文件内容不是有效的图片");
      err.status = 400;
      throw err;
    }
    if (isGif && meta.format !== "gif") {
      const err = new Error("GIF 文件签名校验失败");
      err.status = 400;
      throw err;
    }
    if (isWebp && meta.format !== "webp") {
      const err = new Error("WebP 文件签名校验失败");
      err.status = 400;
      throw err;
    }
    filename = `${unique}${isGif ? ".gif" : ".webp"}`;
    mime = isGif ? "image/gif" : "image/webp";
  } else {
    try {
      buffer = await sharp(file.buffer).webp({ quality: 80 }).toBuffer();
    } catch {
      const err = new Error("图片解析或压缩失败，请检查文件是否损坏");
      err.status = 400;
      throw err;
    }
    filename = `${unique}.webp`;
    mime = "image/webp";
  }

  const { key, url } = await storage.put({
    buffer,
    dir,
    filename,
    mime,
  });

  return { key, url };
}

module.exports = { processAndStoreImage };

