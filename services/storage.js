const fs = require('fs');
const path = require('path');
const { uploadBuffer, getObjectBuffer, getSignedUrl, DEFAULT_EXPIRES } = require('../utils/oss');

// 存储驱动：local=本地磁盘；cos=腾讯云COS。未设置时，生产环境默认 cos，其余环境 local
const DRIVER = (process.env.STORAGE_DRIVER
    || (process.env.NODE_ENV === 'production' ? 'cos' : 'local')).toLowerCase();

const LOCAL_ROOT = path.join(__dirname, '..', 'uploads');

// 规范化 key：去掉开头的 / 和旧的 uploads/ 前缀，兼容历史数据
function normalizeKey(key) {
    let k = String(key).replace(/^\/+/, '');
    if (k.startsWith('uploads/')) k = k.slice('uploads/'.length);
    return k;
}

// ① 上传：统一返回 { key, url }
// 参数：buffer 文件二进制；dir 子目录(如 article)；filename 文件名(含扩展名)；mime 类型
async function put({ buffer, dir = '', filename, mime }) {
    const key = dir ? `${dir}/${filename}` : filename;
    if (DRIVER === 'cos') {
        await uploadBuffer(key, buffer, mime);
        return { key, url: getSignedUrl(key) };
    }
    // local：写入 uploads 硬盘
    const destDir = path.join(LOCAL_ROOT, dir);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(LOCAL_ROOT, key), buffer);
    return { key, url: `/uploads/${key}` };
}

// 读取文件内容 buffer（供 RAG 服务端解析）；仅支持存储 key，外链返回 null
async function getBuffer(keyOrUrl) {
    if (!keyOrUrl) return null;
    if (/^https?:\/\//i.test(keyOrUrl)) return null; // 外链不在此读取
    const key = normalizeKey(keyOrUrl);
    if (DRIVER === 'cos') return getObjectBuffer(key);
    const localPath = path.join(LOCAL_ROOT, key);
    if (!fs.existsSync(localPath)) return null;
    return fs.promises.readFile(localPath);
}

// ② key / 外链 → 可直接访问的 URL
function sign(keyOrUrl, expires = DEFAULT_EXPIRES) {
    if (!keyOrUrl) return '';
    if (/^https?:\/\//i.test(keyOrUrl)) return keyOrUrl; // 外链原样返回
    // 前端打包内的公共静态资源（images、favicon、static，可带或不带前导 /），由站点直接提供，不签名
    if (/^\/?(images|favicon|static)\//i.test(keyOrUrl)) {
      return keyOrUrl.startsWith('/') ? keyOrUrl : '/' + keyOrUrl;
    }
    const key = normalizeKey(keyOrUrl);
    if (DRIVER === 'cos') return getSignedUrl(key, expires);
    return `/uploads/${key}`;
}

// ③ 批量：保留原字段(key，编辑提交用)，按 fieldMap 新增 *_url 字段(显示用)
// fieldMap 例：{ cover: 'cover_url', avatar: 'avatar_url' }
function attachUrls(input, fieldMap, expires = DEFAULT_EXPIRES) {
    if (!input) return input;
    const arr = Array.isArray(input) ? input : [input];
    for (const item of arr) {
        if (!item) continue;
        for (const [src, dst] of Object.entries(fieldMap)) {
            item[dst] = item[src] ? sign(item[src], expires) : '';
        }
    }
    return input;
}

module.exports = { put, getBuffer, sign, attachUrls, normalizeKey, driver: DRIVER };