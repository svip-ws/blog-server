const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

// 基础图片存储配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "../uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + ext);
  },
});

// 2. 文件过滤配置（扩展名白名单精确匹配，避免子串绕过，如 .jpgx）
const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
const IMAGE_MIMES = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];
const fileFilter = (req, file, cb) => {
  const extname = IMAGE_EXTS.includes(path.extname(file.originalname).toLowerCase());
  const mimetype = IMAGE_MIMES.includes(String(file.mimetype).toLowerCase());

  if (extname && mimetype) {
    return cb(null, true);
  } else {
    const err = new Error("格式错误：仅允许上传 JPG/PNG/GIF/WebP 格式的图片！");
    err.status = 400;
    cb(err, false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

// 内存存储的图片上传器：文件以 Buffer 进内存(req.file.buffer)，不落本地盘，用于上传 COS
const imageMemory = multer({
  storage: multer.memoryStorage(),
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});
upload.imageMemory = imageMemory;

// 内存存储的音频上传器：文件以 Buffer 进内存(req.file.buffer)，不落本地盘，用于上传 COS
// 音频不做压缩转码，原样直传
const AUDIO_EXTS = [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"];
const audioFilter = (req, file, cb) => {
  const extOk = AUDIO_EXTS.includes(path.extname(file.originalname).toLowerCase());
  const mimeOk = /^audio\//.test(String(file.mimetype).toLowerCase());
  if (extOk && mimeOk) {
    return cb(null, true);
  }
  const err = new Error("格式错误：仅允许上传音频文件 (mp3/wav/ogg/m4a/flac/aac)");
  err.status = 400;
  cb(err, false);
};
const audioMemory = multer({
  storage: multer.memoryStorage(),
  fileFilter: audioFilter,
  limits: {
    fileSize: 30 * 1024 * 1024,
  },
});
upload.audioMemory = audioMemory;

// 内存存储的通用媒体上传器（图片+视频），用于轮播 banner
const MEDIA_IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
const MEDIA_VIDEO_EXTS = [".mp4", ".webm", ".mov", ".m4v"];
const mediaFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = String(file.mimetype).toLowerCase();
  const isImage = MEDIA_IMAGE_EXTS.includes(ext) && /^image\//.test(mime);
  const isVideo = MEDIA_VIDEO_EXTS.includes(ext) && /^video\//.test(mime);
  if (isImage || isVideo) {
    return cb(null, true);
  }
  const err = new Error("格式错误：仅允许上传图片(jpg/png/gif/webp)或视频(mp4/webm/mov)");
  err.status = 400;
  cb(err, false);
};
const mediaMemory = multer({
  storage: multer.memoryStorage(),
  fileFilter: mediaFilter,
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});
upload.mediaMemory = mediaMemory;

// 3. WebP 自动转换中间件
upload.convertToWebp = async (req, res, next) => {
  if (!req.file) return next();

  try {
    const originalPath = req.file.path;
    const ext = path.extname(originalPath);
    if (ext.toLowerCase() === ".gif" || ext.toLowerCase() === ".webp") {
      return next();
    }

    const webpFilename = `${path.basename(originalPath, ext)}.webp`;
    const webpPath = path.join(path.dirname(originalPath), webpFilename);

    await sharp(originalPath)
      .webp({ quality: 80 })
      .toFile(webpPath);

    if (fs.existsSync(originalPath)) {
      fs.unlinkSync(originalPath);
    }
    req.file.path = webpPath;
    req.file.filename = webpFilename;
    req.file.mimetype = "image/webp";
    next();
  } catch (err) {
    console.error("--- ⚠️ WebP 压缩转换失败，降级使用原图:", err.message);
    next();
  }
};

// 4. RAG 知识库文档文件过滤（扩展名白名单精确匹配；仅保留 ragService 实际可解析的类型）
const DOC_EXTS = [".pdf", ".txt", ".md", ".markdown", ".doc", ".docx", ".csv", ".json", ".xls", ".xlsx", ".png", ".jpg", ".jpeg", ".webp"];
const docFileFilter = (req, file, cb) => {
  const extname = DOC_EXTS.includes(path.extname(file.originalname).toLowerCase());

  if (extname) {
    return cb(null, true);
  } else {
    const err = new Error("格式错误：仅支持 PDF、TXT、MD、DOC/DOCX、CSV、JSON、Excel(XLS/XLSX) 或图片格式的文档！");
    err.status = 400;
    cb(err, false);
  }
};

const docUpload = multer({
  storage: storage,
  fileFilter: docFileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB 限制
  },
});

upload.docUpload = docUpload;

// RAG 文档内存上传器（文件原样直传统一存储；文档不压缩，避免损坏 PDF/DOCX/XLSX）
const docMemory = multer({
  storage: multer.memoryStorage(),
  fileFilter: docFileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
});
upload.docMemory = docMemory;

// 通用上传配置工厂
function createStorage(subdir = "", lowerExt = false) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, "..", "uploads", subdir);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      let ext = path.extname(file.originalname);
      if (lowerExt) ext = ext.toLowerCase();
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, uniqueSuffix + ext);
    },
  });
}

function createUpload({ subdir = "", exts = [], mime = /.*/, maxSize = 10 * 1024 * 1024, lowerExt = false, message = "文件类型不被允许" }) {
  const fileFilter = (req, file, cb) => {
    const extOk = exts.includes(path.extname(file.originalname).toLowerCase());
    const mimeOk = new RegExp(mime).test(String(file.mimetype).toLowerCase());
    if (extOk && mimeOk) return cb(null, true);
    const err = new Error(message);
    err.status = 400;
    cb(err, false);
  };
  return multer({
    storage: createStorage(subdir, lowerExt),
    fileFilter,
    limits: { fileSize: maxSize },
  });
}

// 轮播图媒体：图片 + 常见视频（收紧原先无过滤的 upload.any()）
upload.bannerUpload = createUpload({
  subdir: "",
  exts: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".webm"],
  mime: "^image/|^video/",
  maxSize: 50 * 1024 * 1024,
  message: "格式错误：仅允许上传图片(jpg/jpeg/png/gif/webp)或视频(mp4/webm)！",
});

// 音乐：独立 music 子目录，仅音频
upload.musicUpload = createUpload({
  subdir: "music",
  exts: [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"],
  mime: "^audio/",
  maxSize: 30 * 1024 * 1024,
  lowerExt: true,
  message: "格式错误：仅允许上传音频文件 (mp3/wav/ogg/m4a/flac/aac)",
});

// 快照原图：独立 snap/originals 子目录，仅图片
upload.snapshotUpload = createUpload({
  subdir: "snap/originals",
  exts: [".jpg", ".jpeg", ".png", ".webp"],
  mime: "^image/(jpeg|png|webp)",
  maxSize: 10 * 1024 * 1024,
  message: "格式错误：仅允许上传 JPG, JPEG, PNG, WebP 格式的图片！",
});

upload.createUpload = createUpload;

module.exports = upload;
