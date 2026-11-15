const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const db = require("../config/db");
const RAG_CONFIG = require("../config/ragConfig");
const storage = require("./storage");

let PDFParse = null;
let mammoth = null;
let XLSX = null;

// 文档全文缓存：加上限的 LRU，避免文档数量/体积增长后内存只增不减
const docTextCache = new Map();
const DOC_CACHE_MAX = 20;

function setDocCache(key, value) {
  // 先删再插，保证该键刷新到 Map 迭代顺序末尾（最近使用）
  docTextCache.delete(key);
  docTextCache.set(key, value);
  // 超过容量时淘汰最久未使用的键（Map 迭代顺序首个）
  while (docTextCache.size > DOC_CACHE_MAX) {
    const oldestKey = docTextCache.keys().next().value;
    docTextCache.delete(oldestKey);
  }
}

/**
 * 清除 RAG 文档缓存 (在上传/删除文档时调用)
 */
function clearDocCache() {
  docTextCache.clear();
}

/**
 * 修复包含 latin1 乱码的文件名
 */
const fixFilenameEncoding = (str) => {
  if (!str) return "";
  try {
    const decoded = Buffer.from(str, "latin1").toString("utf8");
    if (decoded && !decoded.includes("\uFFFD")) {
      return decoded;
    }
  } catch (e) {}
  return str;
};

/**
 * 全格式文档文本提取器：从文件 Buffer 提取 (PDF / DOCX / XLSX / XLS / CSV / JSON / TXT / MD / LOG / HTML)
 * @param {Buffer} dataBuffer 文件二进制
 * @param {string} ext 扩展名（含点、小写）
 */
async function extractTextFromBuffer(dataBuffer, ext) {
  if (!dataBuffer) return "";

  try {
    let rawText = "";

    // 1. PDF 文件解析
    if (ext === ".pdf") {
      if (!PDFParse) {
        try {
          const pdfModule = require("pdf-parse");
          PDFParse = pdfModule.PDFParse || pdfModule;
        } catch (e) {}
      }

      if (PDFParse) {
        const uint8Array = new Uint8Array(dataBuffer);
        const parser = new PDFParse(uint8Array);
        const res = await parser.getText();
        rawText = typeof res === "string" ? res : (res?.text || "");
      }

      if (!rawText || !rawText.trim()) {
        const rawStr = dataBuffer.toString("utf8");
        rawText = rawStr.replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s,.:;!?"'()-]/g, " ").replace(/\s+/g, " ");
      }
    }
    // 2. Word 文档 (.docx / .doc) 解析
    else if ([".docx", ".doc"].includes(ext)) {
      if (!mammoth) {
        try { mammoth = require("mammoth"); } catch (e) {}
      }
      if (mammoth) {
        const result = await mammoth.extractRawText({ buffer: dataBuffer });
        if (result && result.value) {
          rawText = result.value;
        }
      }
    }
    // 3. Excel 电子表格 (.xlsx / .xls) 及 CSV 解析 (转化为格式化 Markdown 表格)
    else if ([".xlsx", ".xls", ".csv"].includes(ext)) {
      if (!XLSX) {
        try { XLSX = require("xlsx"); } catch (e) {}
      }
      if (XLSX) {
        const workbook = XLSX.read(dataBuffer, { type: "buffer" });
        const sheetTexts = [];
        workbook.SheetNames.forEach(sheetName => {
          const worksheet = workbook.Sheets[sheetName];
          const csvText = XLSX.utils.sheet_to_csv(worksheet);
          if (csvText && csvText.trim()) {
            const lines = csvText.split('\n').filter(Boolean);
            const mdTable = lines.map(line => `| ${line.split(',').join(' | ')} |`).join('\n');
            sheetTexts.push(`### 工作表: ${sheetName}\n${mdTable}`);
          }
        });
        if (sheetTexts.length > 0) {
          rawText = sheetTexts.join("\n\n");
        }
      }
    }
    // 4. JSON 文本格式化解析
    else if (ext === ".json") {
      const raw = dataBuffer.toString("utf8");
      try {
        const parsed = JSON.parse(raw);
        rawText = JSON.stringify(parsed, null, 2);
      } catch (e) {
        rawText = raw;
      }
    }
    // 5. TXT / MD / LOG / HTML 文本
    else if ([".txt", ".md", ".markdown", ".log", ".html", ".xml"].includes(ext)) {
      rawText = dataBuffer.toString("utf8");
    } else {
      rawText = dataBuffer.toString("utf8").substring(0, 150000);
    }

    if (!rawText) return "";

    // 消除 PDF/Word 排版中汉字/数字之间由布局坐标产生的独立空格与换行
    const cleanedText = rawText.replace(/([\u4e00-\u9fa5a-zA-Z0-9（）():：])[\s\t\r\n]+(?=[\u4e00-\u9fa5a-zA-Z0-9（）():：])/g, "$1");
    return cleanedText;
  } catch (err) {
    console.error(`--- ❌ 提取文档 [${ext}] 文本失败:`, err.message);
    return "";
  }
}

/**
 * 兼容入口：从本地磁盘路径读取并提取文本（本地脚本 / 调试用）
 */
async function extractTextFromFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  const ext = path.extname(filePath).toLowerCase();
  const dataBuffer = await fsp.readFile(filePath);
  return extractTextFromBuffer(dataBuffer, ext);
}

/**
 * 结构感知智能文本切片 (Chunking): 维持段落、表格与标题完整性
 */
function chunkTextStructured(text, chunkSize = 1200, overlap = 250) {
  if (!text) return [];
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= chunkSize) return [clean];

  // 按自然段落、表格边框及标题切分
  const paragraphs = clean.split(/(?:\n\s*\n|(?=^#{1,4}\s)|(?=^\|\s))/m);
  const chunks = [];
  let currentChunk = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if ((currentChunk.length + trimmed.length + 2) <= chunkSize) {
      currentChunk += (currentChunk ? "\n\n" : "") + trimmed;
    } else {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }

      if (trimmed.length > chunkSize) {
        // 单个超级长段落使用滑动窗口
        let start = 0;
        while (start < trimmed.length) {
          const end = Math.min(start + chunkSize, trimmed.length);
          chunks.push(trimmed.slice(start, end).trim());
          if (end >= trimmed.length) break;
          start += (chunkSize - overlap);
        }
        currentChunk = "";
      } else {
        // 重叠部分保留上一块末尾 200 字符
        const tail = currentChunk.slice(-overlap);
        currentChunk = tail + "\n\n" + trimmed;
      }
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * 从文本中精准提取月份集合 (1-12)
 */
function detectMonths(str = "") {
  if (!str) return [];
  const months = new Set();
  const map = [
    { num: 1, keys: ['1月', '1月份', '一月', '一月份'] },    { num: 2, keys: ['2月', '2月份', '二月', '二月份'] },
    { num: 3, keys: ['3月', '3月份', '三月', '三月份'] },
    { num: 4, keys: ['4月', '4月份', '四月', '四月份'] },
    { num: 5, keys: ['5月', '5月份', '五月', '五月份'] },
    { num: 6, keys: ['6月', '6月份', '六月', '六月份'] },
    { num: 7, keys: ['7月', '7月份', '七月', '七月份'] },
    { num: 8, keys: ['8月', '8月份', '八月', '八月份'] },
    { num: 9, keys: ['9月', '9月份', '九月', '九月份'] },
    { num: 10, keys: ['10月', '10月份', '十月', '十月份'] },
    { num: 11, keys: ['11月', '11月份', '十一月', '十一月份'] },
    { num: 12, keys: ['12月', '12月份', '十二月', '十二月份'] }
  ];
  map.forEach(({ num, keys }) => {
    if (keys.some(k => str.includes(k))) {
      months.add(num);
    }
  });
  return Array.from(months);
}

/**
 * 从文本中精准提取年份集合 (如 2026, 2025)
 */
function detectYears(str = "") {
  if (!str) return [];
  const years = new Set();
  const map = RAG_CONFIG.years.map(y => ({ num: y.num, keys: [String(y.num), y.cn] }));
  map.forEach(({ num, keys }) => {
    if (keys.some(k => str.includes(k))) {
      years.add(num);
    }
  });
  return Array.from(years);
}

/**
 * 核心：查询关键词归一化、同义词扩展与无效单字停用词过滤
 */
function normalizeQueryKeywords(query = "") {
  const keywords = new Set();
  if (!query) return [];

  const rawClean = query.replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, " ");
  const tokens = rawClean.split(/\s+/).filter(Boolean);
  tokens.forEach(t => {
    if (t.length >= 2) keywords.add(t);
  });

  // 产品与核心实体别名扩展（词表来自 config/ragConfig，与引擎解耦）
  RAG_CONFIG.aliasGroups.forEach(keys => {
    if (keys.some(k => query.includes(k))) {
      keys.forEach(k => keywords.add(k));
    }
  });

  // 阿拉伯数字与中文对照：年份来自业务配置，月份为通用规则
  const yearNumMap = RAG_CONFIG.years.map(y => ({ ar: String(y.num), cn: y.cn }));
  const monthNumMap = [
    { ar: '1月', cn: '一月' }, { ar: '2月', cn: '二月' }, { ar: '3月', cn: '三月' },
    { ar: '4月', cn: '四月' }, { ar: '5月', cn: '五月' }, { ar: '6月', cn: '六月' },
    { ar: '7月', cn: '七月' }, { ar: '8月', cn: '八月' }, { ar: '9月', cn: '九月' },
    { ar: '10月', cn: '十月' }, { ar: '11月', cn: '十一月' }, { ar: '12月', cn: '十二月' }
  ];
  const numMap = yearNumMap.concat(monthNumMap);

  let converted = query;
  numMap.forEach(({ ar, cn }) => {
    if (query.includes(ar)) {
      keywords.add(cn);
      keywords.add(cn + '月');
      keywords.add(cn + '月份');
      converted = converted.replace(new RegExp(ar, 'g'), cn);
    }
    if (query.includes(cn)) {
      keywords.add(ar);
      keywords.add(ar + '月');
      keywords.add(ar + '月份');
      converted = converted.replace(new RegExp(cn, 'g'), ar);
    }
  });

  const cleanChinese = query.replace(/[^\u4e00-\u9fa5]/g, "");
  for (let i = 0; i < cleanChinese.length - 1; i++) {
    const bi = cleanChinese.slice(i, i + 2);
    // 过滤无意义的单/双字通用噪词（停用表来自 config/ragConfig）
    if (!RAG_CONFIG.bigramStopwords.includes(bi)) {
      keywords.add(bi);
    }
  }

  return Array.from(keywords).filter(k => k.length >= 1);
}

/**
 * 多因子智能切片相关度打分器
 */
function calculateChunkScore(chunk, keywords, query, filename) {
  if (!chunk) return 0;
  let score = 0;

  const chunkLower = chunk.toLowerCase();
  const queryLower = query.toLowerCase();
  const fileLower = (filename || "").toLowerCase();

  // 1. 完全子句精确匹配 (+50分)
  if (query && chunkLower.includes(queryLower)) score += 50;

  // 2. 文件名主题与查询词强关联 (+45分/+30分)
  for (const kw of keywords) {
    if (kw.length >= 3 && fileLower.includes(kw.toLowerCase())) {
      score += 45;
      break;
    } else if (kw.length >= 2 && fileLower.includes(kw.toLowerCase())) {
      score += 30;
      break;
    }
  }

  // 3. 时间/月份维度强关联系数
  const queryMonths = detectMonths(query);
  const fileMonths = detectMonths(filename);
  const chunkMonths = detectMonths(chunk);

  if (queryMonths.length > 0) {
    const monthMatchedInFile = queryMonths.some(m => fileMonths.includes(m));
    if (monthMatchedInFile) {
      score += 65; // 目标月份与文件名相符
    } else if (fileMonths.length > 0) {
      score -= 50; // 跨月份严重冲突扣分
    }

    if (queryMonths.some(m => chunkMonths.includes(m))) {
      score += 25;
    }
  }

  const queryYears = detectYears(query);
  const fileYears = detectYears(filename);
  if (queryYears.length > 0) {
    if (queryYears.some(y => fileYears.includes(y))) {
      score += 25;
    } else if (fileYears.length > 0) {
      score -= 30;
    }
  }

  // 4. 实体 + 核心指标在同一切片中的共现奖励 (+20分)
  const hasIndicator = RAG_CONFIG.indicatorKeywords.some(ind => chunkLower.includes(ind.toLowerCase()));
  if (hasIndicator) {
    score += 15;
  }

  // 5. 组织架构与定岗定编专用匹配奖励 (+40分)
  if ((chunkLower.includes("岗") || chunkLower.includes("岗位")) && (chunkLower.includes("编") || chunkLower.includes("编制"))) {
    if (queryLower.includes("岗") || queryLower.includes("编") || queryLower.includes("岗位") || queryLower.includes("编制") || queryLower.includes("架构")) {
      score += 40;
    }
  }

  // 5. N-Gram 关键词密度计算
  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    if (chunkLower.includes(kwLower)) {
      const matches = chunkLower.split(kwLower).length - 1;
      score += (kw.length * 3.0) * Math.min(matches, 5);
    }
  }

  return score;
}

/**
 * 知识库检索（knowledge_search 工具的实现）：返回纯参考文本，
 * 不附带输出指令，仅返回高分切片内容，由模型自行组织答案。
 */
async function searchKnowledgeBase(userMessage = "", topK = 6) {
  try {
    let rows = [];
    try {
      [rows] = await db.query(
        "SELECT id, filename, COALESCE(filepath, file_path) AS filepath, COALESCE(file_size, 1024) AS file_size FROM ai_documents WHERE status = 'indexed' OR vector_indexed = 1 OR status = 'ready' ORDER BY id DESC"
      );
    } catch (e) {
      [rows] = await db.query(
        "SELECT id, filename, file_path AS filepath, 1024 AS file_size FROM ai_documents ORDER BY id DESC"
      );
    }

    if (!rows || rows.length === 0) return "";

    const keywords = normalizeQueryKeywords(userMessage);
    const isOverviewQuery = new RegExp(RAG_CONFIG.overviewPattern).test(userMessage);
    const scoredChunks = [];
    const MIN_RELEVANCE_SCORE = 35;

    for (const doc of rows) {
      const cleanFilename = fixFilenameEncoding(doc.filename);
      const relPath = doc.filepath || "";
      if (!relPath) continue;

      // 统一从存储取文件 buffer（local 读磁盘 / cos 下载对象），不再依赖本地路径存在
      let fullText = docTextCache.get(relPath);
      if (fullText) {
        docTextCache.delete(relPath);
        docTextCache.set(relPath, fullText);
      } else {
        const fileBuffer = await storage.getBuffer(relPath);
        if (!fileBuffer) continue;
        const ext = path.extname(cleanFilename).toLowerCase()
          || path.extname(relPath).toLowerCase();
        fullText = await extractTextFromBuffer(fileBuffer, ext);
        if (fullText) setDocCache(relPath, fullText);
      }
      if (!fullText || !fullText.trim()) continue;

      const chunks = chunkTextStructured(fullText, 1200, 300);
      chunks.forEach((chunk, index) => {
        let score = calculateChunkScore(chunk, keywords, userMessage, cleanFilename);
        if (isOverviewQuery) {
          if (index === 0) score += 15;
          if (index === 1) score += 8;
        }
        if (score >= MIN_RELEVANCE_SCORE) {
          scoredChunks.push({ filename: cleanFilename, text: chunk, score });
        }
      });
    }

    if (scoredChunks.length === 0) return "";
    scoredChunks.sort((a, b) => b.score - a.score);
    const top = scoredChunks.slice(0, topK);
    return top.map((c, i) =>
      `【参考片段${i + 1}·来源《${c.filename}》】\n${c.text}`
    ).join("\n\n---\n\n");
  } catch (err) {
    console.error("--- ❌ searchKnowledgeBase 检索失败:", err && err.message);
    return "";
  }
}

module.exports = {
  searchKnowledgeBase,
  extractTextFromFile,
  fixFilenameEncoding,
  clearDocCache,
  normalizeQueryKeywords,
  chunkTextStructured,
  chunkText: chunkTextStructured,
  calculateChunkScore,
  detectMonths,
  detectYears
};
