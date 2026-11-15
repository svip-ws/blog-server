const storage = require("../services/storage");

// 匹配 <img ... src="...">（src 前为空白，避免误匹配 data-src；wangEditor 输出双引号）
const IMG_RE = /(<img\b[^>]*?\ssrc=")([^"]*)("[^>]*?>)/gi;

// 读取时：正文 img 的 src（key / 外链 / 前端静态）统一签名或放行
function signContentImages(html) {
  if (!html) return html;
  return html.replace(IMG_RE, (m, pre, src, post) => pre + storage.sign(src) + post);
}

// 识别本存储对象的 URL：COS 对象 URL、/uploads/ 本地路径（可带 http://host 前缀）
const COS_HOST_RE = /^https?:\/\/[^/]*\.cos\.[^/]+\.myqcloud\.com\//i;
const UPLOADS_RE = /^(?:https?:\/\/[^/]+)?\/uploads\//i;

// 单个 src：属于本存储的 URL → 还原为最终 key（剥掉 /uploads/ 与裸 uploads/ 前缀）
function urlToStoredKey(src) {
  let key;
  if (COS_HOST_RE.test(src)) {
    try {
      key = decodeURIComponent(new URL(src).pathname.replace(/^\/+/, ""));
    } catch (e) {
      return src;
    }
  } else if (UPLOADS_RE.test(src)) {
    const noQuery = src.split("?")[0];
    const marker = "/uploads/";
    const idx = noQuery.toLowerCase().indexOf(marker);
    key = decodeURIComponent(noQuery.slice(idx + marker.length));
  } else if (/^uploads\//i.test(src)) {
    key = src.replace(/^uploads\//i, "");
  } else {
    return src; // 外链 / 前端静态 / 已经是最终 key，原样
  }
  return storage.normalizeKey(key);
}

// 保存时：正文 img 中本存储的 URL 还原为 key（永久有效），外链/静态保留
function contentUrlsToKeys(html) {
  if (!html) return html;
  return html.replace(IMG_RE, (m, pre, src, post) => pre + urlToStoredKey(src) + post);
}

// 提取正文里所有 img 的 src（供覆盖核对）
function extractImgSrcs(html) {
  const out = [];
  if (html) html.replace(IMG_RE, (m, pre, src) => { out.push(src); return m; });
  return out;
}

module.exports = { signContentImages, contentUrlsToKeys, urlToStoredKey, extractImgSrcs };
