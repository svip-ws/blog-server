/**
 * Snapshot 3D 闪卡领域服务
 * ------------------------------------------------------------------
 * 承接原 snapshotController 中的：建表/种子、GLB 生成、生成流水线
 * (Node 保底 + Python 高阶) 编排、进度文件读取与磁盘路径解析。
 * 控制器只负责 HTTP 入参与响应。
 */
const db = require("../config/db");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const storage = require("./storage");

const SERVER_ROOT = path.join(__dirname, "..");
const UPLOADS_DIR = path.join(SERVER_ROOT, "uploads");
const CARDS_DIR = path.join(UPLOADS_DIR, "snap", "cards");
const ORIGINALS_REL_DIR = path.join(UPLOADS_DIR, "snap", "originals");
const PY_SCRIPT = path.join(SERVER_ROOT, "scripts", "run_pipeline.py");

// 预设高奢 3D 闪卡（当数据库未初始化或出错时的保底数据）
const PRESET_CARDS = [
  {
    id: 1, card_no: "No.001", name: "暮光霓虹 · 赛博雨夜", category: "赛博朋克",
    style_preset: "cyber", description: "夜幕降临时的城市霓虹，雨水折射出五彩斑斓的流光，仿佛置身未来之城",
    cover: "/uploads/placeholder.svg", parallax_intensity: 1.5, is_published: 1, status: 1,
    sort_order: 10, view_count: 1280, like_count: 420, create_time: "2026-09-08 20:30:00"
  },
  {
    id: 2, card_no: "No.002", name: "雪山云海 · 晨曦初照", category: "风景",
    style_preset: "prism", description: "金色的晨光洒在陡峭的雪峰之上，云雾在山谷间缓缓翻腾，浩瀚而圣洁",
    cover: "/uploads/placeholder.svg", parallax_intensity: 1.2, is_published: 1, status: 1,
    sort_order: 9, view_count: 960, like_count: 310, create_time: "2026-09-07 18:20:00"
  },
  {
    id: 3, card_no: "No.003", name: "樱花雨落 · 少女之约", category: "二次元",
    style_preset: "aurora", description: "春日微风吹过漫天粉色樱花瓣，如梦似幻的二次元少女物语",
    cover: "/uploads/placeholder.svg", parallax_intensity: 1.8, is_published: 1, status: 1,
    sort_order: 8, view_count: 1540, like_count: 580, create_time: "2026-09-06 14:15:00"
  }
];

function formatDate(dateInput) {
  if (!dateInput) return "";
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return String(dateInput);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 把对外 URL / 相对路径解析为磁盘绝对路径
function resolveDiskPath(rel) {
  if (!rel) return "";
  if (path.isAbsolute(rel)) return rel;
  const clean = rel.startsWith("/") ? rel.slice(1) : rel;
  return path.join(SERVER_ROOT, clean);
}

// 自动初始化与建表逻辑（兼容新字段）；幂等且只执行一次
let tableReady = null;
function ensureTableExists() {
  if (!tableReady) tableReady = doEnsureTableExists();
  return tableReady;
}

async function doEnsureTableExists() {
  try {
    const createTableSql = `
      CREATE TABLE IF NOT EXISTS snapshot_card (
        id INT AUTO_INCREMENT PRIMARY KEY,
        card_no VARCHAR(32) NOT NULL DEFAULT 'No.001',
        name VARCHAR(128) NOT NULL,
        category VARCHAR(64) NOT NULL DEFAULT '风景',
        style_preset VARCHAR(64) NOT NULL DEFAULT 'standard',
        description TEXT,
        cover VARCHAR(512) NOT NULL DEFAULT '',
        original_image VARCHAR(512) DEFAULT '',
        glb_path VARCHAR(512) DEFAULT '',
        blend_path VARCHAR(512) DEFAULT '',
        thumbnail VARCHAR(512) DEFAULT '',
        images JSON,
        parallax_intensity FLOAT NOT NULL DEFAULT 1.5,
        is_published TINYINT(1) NOT NULL DEFAULT 1,
        status TINYINT NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        view_count INT NOT NULL DEFAULT 0,
        like_count INT NOT NULL DEFAULT 0,
        error_log TEXT,
        config_json JSON,
        create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `;
    await db.query(createTableSql);

    const alterCols = [
      "ADD COLUMN status TINYINT NOT NULL DEFAULT 1",
      "ADD COLUMN original_image VARCHAR(512) DEFAULT ''",
      "ADD COLUMN glb_path VARCHAR(512) DEFAULT ''",
      "ADD COLUMN blend_path VARCHAR(512) DEFAULT ''",
      "ADD COLUMN thumbnail VARCHAR(512) DEFAULT ''",
      "ADD COLUMN error_log TEXT"
    ];
    for (const alterSql of alterCols) {
      try { await db.query(`ALTER TABLE snapshot_card ${alterSql}`); } catch (e) {}
    }

    const [rows] = await db.query("SELECT COUNT(*) AS total FROM snapshot_card");
    if (rows[0].total === 0) {
      for (const card of PRESET_CARDS) {
        await db.query(
          `INSERT INTO snapshot_card (name, card_no, category, style_preset, description, cover, parallax_intensity, is_published, status, sort_order, view_count, like_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [card.name, card.card_no, card.category, card.style_preset, card.description, card.cover,
           card.parallax_intensity, card.is_published, card.status || 1, card.sort_order, card.view_count, card.like_count]
        );
      }
      console.log("--- ✦ 已自动向 snapshot_card 表中填入预设闪卡数据 ---");
    }
  } catch (e) {
    console.error("数据库 snapshot_card 自动准备提示:", e.message);
  }
}

// 启动即触发建表（保持原有时序；多次调用复用同一 Promise）
ensureTableExists();

function createMinimalGLB() {
  const jsonBuf = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0", generator: "HoloCardStudio-v2.0" },
      scenes: [{ nodes: [0] }],
      nodes: [{ name: "HoloCardNode" }]
    }),
    "utf-8"
  );
  const header = Buffer.alloc(12);
  header.write("glTF", 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length, 8);

  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(jsonBuf.length, 0);
  chunkHeader.write("JSON", 4);

  return Buffer.concat([header, chunkHeader, jsonBuf]);
}

/**
 * 触发 holo-card-studio 后台生成流水线
 * 原生双引擎：Node.js 极速极稳保底 + Python 高阶图层扩展
 */
async function triggerCardPipeline(cardId, formFields, originalImagePath) {
  const projectDir = path.join(CARDS_DIR, String(cardId));
  if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });

  const glbRelPath = `/uploads/snap/cards/${cardId}/model.glb`;
  const previewRelPath = `/uploads/snap/cards/${cardId}/preview.png`;
  const projectPreviewPath = path.join(projectDir, "preview.png");
  const projectGlbPath = path.join(projectDir, "model.glb");
  const projectInputPath = path.join(projectDir, "input.png");

  // 1. 拷贝原图作为输入与预览（保底）
  if (originalImagePath && fs.existsSync(originalImagePath)) {
    try {
      fs.copyFileSync(originalImagePath, projectInputPath);
      fs.copyFileSync(originalImagePath, projectPreviewPath);
    } catch (err) {
      console.error(`[Card #${cardId}] 图片拷贝提醒:`, err.message);
    }
  }

  // 2. 生成标准 glTF/GLB
  try {
    fs.writeFileSync(projectGlbPath, createMinimalGLB());
  } catch (err) {
    console.error(`[Card #${cardId}] GLB 生成提醒:`, err.message);
  }

  // 3. 写入 card-config.json
  const configObj = {
    cardId,
    preset: formFields.style_preset || "standard",
    parallax: parseFloat(formFields.parallax_intensity || 1.5),
    prompt: formFields.description || formFields.name || "",
    glbPath: glbRelPath,
    thumbnail: previewRelPath,
    version: "Holo-Studio-v2.0"
  };
  fs.writeFileSync(path.join(projectDir, "card-config.json"), JSON.stringify(configObj, null, 2));

  // 更新数据库卡片为完成状态
  const targetStatus = formFields.is_published !== undefined && formFields.is_published !== "" ? Number(formFields.is_published) : 1;
  try {
    await db.query(
      `UPDATE snapshot_card SET status = ?, cover = ?, thumbnail = ?, glb_path = ?, config_json = ?, error_log = NULL WHERE id = ?`,
      [targetStatus, previewRelPath, previewRelPath, glbRelPath, JSON.stringify(configObj), cardId]
    );
  } catch (err) {
    console.error(`[Card #${cardId}] DB 状态更新提醒:`, err.message);
  }

  // 5. 写入 100% progress.json
  const completeProgress = {
    id: Number(cardId), status: targetStatus, progress: 100, message: "生成完成!",
    thumbnail: previewRelPath, error_log: "", updated_at: new Date().toISOString()
  };
  fs.writeFileSync(path.join(projectDir, "progress.json"), JSON.stringify(completeProgress, null, 2));

  // 6. 异步启动 Python 高阶微调（不阻塞，失败不影响保底产物）
  const pythonCmd = process.platform === "win32" ? "python" : "python3";
  const args = [
    PY_SCRIPT, "--project", projectDir, "--card-id", String(cardId),
    "--prompt", formFields.description || formFields.name || "",
    "--preset", formFields.style_preset || "standard",
    "--parallax", String(formFields.parallax_intensity || 1.5)
  ];

  // COS 模式：Python 结束 / 失败 / 超时后，把最终本地产物上传 COS 并更新 DB
  let publishSettled = false;
  let publishFallback = null;
  const doPublish = () => {
    if (publishSettled) return;
    publishSettled = true;
    if (publishFallback) clearTimeout(publishFallback);
    publishFinalArtifacts(cardId, projectDir, targetStatus);
  };
  if (storage.driver === "cos") {
    publishFallback = setTimeout(doPublish, 30000);
  }

  try {
    const pyProcess = spawn(pythonCmd, args);
    pyProcess.stdout.on("data", (d) => console.log(`[PyPipeline ${cardId}] ${d.toString().trim()}`));
    pyProcess.stderr.on("data", (d) => console.log(`[PyPipeline Log ${cardId}] ${d.toString().trim()}`));
    if (storage.driver === "cos") {
      pyProcess.on("error", doPublish);
      pyProcess.on("close", doPublish);
    }
  } catch (pyErr) {
    console.log(`[PyPipeline Skip] Python 异步微调跳过: ${pyErr.message}`);
    if (storage.driver === "cos") doPublish();
  }
}

// COS 模式：读取本地最终产物（preview.png / model.glb），上传统一存储并更新数据库
// 本地工作目录与中间文件仍保留在磁盘（Python 读写），仅最终产物外发
async function publishFinalArtifacts(cardId, projectDir, targetStatus) {
  try {
    const previewLocal = path.join(projectDir, "preview.png");
    const glbLocal = path.join(projectDir, "model.glb");

    let coverKey = "";
    if (fs.existsSync(previewLocal)) {
      const webpBuf = await sharp(fs.readFileSync(previewLocal)).webp({ quality: 80 }).toBuffer();
      coverKey = (await storage.put({
        buffer: webpBuf,
        dir: `snap/cards/${cardId}`,
        filename: "preview.webp",
        mime: "image/webp",
      })).key;
    }

    let glbKey = "";
    if (fs.existsSync(glbLocal)) {
      glbKey = (await storage.put({
        buffer: fs.readFileSync(glbLocal),
        dir: `snap/cards/${cardId}`,
        filename: "model.glb",
        mime: "model/gltf-binary",
      })).key;
    }

    if (coverKey) {
      await db.query(
        `UPDATE snapshot_card SET status=?, cover=?, thumbnail=?, glb_path=?, error_log=NULL WHERE id=?`,
        [targetStatus, coverKey, coverKey, glbKey, cardId]
      );
    }
    console.log(`--- ✦ [Card #${cardId}] 最终产物已发布到 ${storage.driver} ---`);
  } catch (err) {
    console.error(`[Card #${cardId}] 产物发布失败:`, err.message);
  }
}

// 读取卡片项目目录下的 progress.json（无则返回 null）
function readPipelineProgress(cardId) {
  const progressFile = path.join(CARDS_DIR, String(Number(cardId)), "progress.json");
  if (fs.existsSync(progressFile)) {
    try { return JSON.parse(fs.readFileSync(progressFile, "utf8")); } catch (e) {}
  }
  return null;
}

module.exports = {
  PRESET_CARDS,
  formatDate,
  ensureTableExists,
  triggerCardPipeline,
  readPipelineProgress,
  resolveDiskPath,
  paths: { CARDS_DIR, ORIGINALS_REL_DIR }
};
