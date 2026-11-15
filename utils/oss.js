const util = require('util');
const { cos, bucket, region } = require('../config/cos');

// SDK 是回调风格，这里转成 async/await，并绑定 cos 上下文
const putObject = util.promisify(cos.putObject).bind(cos);
const getObject = util.promisify(cos.getObject).bind(cos);
const headObject = util.promisify(cos.headObject).bind(cos);
const copyObject = util.promisify(cos.putObjectCopy).bind(cos);

const DEFAULT_EXPIRES = 7200; // 签名有效期：2 小时（秒）

// ① 上传一个文件 buffer 到 COS，返回对象 key（数据库存这个）
async function uploadBuffer(key, buffer, mime) {
    await putObject({
        Bucket: bucket,
        Region: region,
        Key: key,
        Body: buffer,
        Headers: { 'Content-Type': mime || 'application/octet-stream' },
    });
    return key;
}

// 下载一个对象，返回 Buffer（供 RAG 服务端读取解析，不经过浏览器）
async function getObjectBuffer(key) {
    const data = await getObject({
        Bucket: bucket,
        Region: region,
        Key: key,
    });
    return Buffer.isBuffer(data.Body) ? data.Body : Buffer.from(data.Body);
}

// 判断对象是否已存在（迁移幂等：已存在则跳过上传）
async function objectExists(key) {
  try {
    await headObject({ Bucket: bucket, Region: region, Key: key });
    return true;
  } catch (e) {
    if (e && (e.statusCode === 404 || e.code === "NotFound")) return false;
    throw e;
  }
}

// 服务端复制对象（同桶同地域，不走本地带宽、免费、秒完成）；用于旧 key → 新 key 归一化
async function copyObjectKey(srcKey, destKey) {
  const source = `${bucket}.cos.${region}.myqcloud.com/` +
    srcKey.split("/").map(encodeURIComponent).join("/");
  await copyObject({
    Bucket: bucket,
    Region: region,
    Key: destKey,
    CopySource: source,
  });
  return destKey;
}

// ② 给单个 key 生成预签名 URL；若是 http 外链则原样返回
function getSignedUrl(keyOrUrl, expires = DEFAULT_EXPIRES) {
    if (!keyOrUrl) return '';
    if (/^https?:\/\//i.test(keyOrUrl)) return keyOrUrl; // 外链不签名
    // 此 SDK 版本(v3)不传回调时，直接返回签名后的 URL 字符串
    return cos.getObjectUrl({
        Bucket: bucket,
        Region: region,
        Key: keyOrUrl,
        Sign: true,       // 私有桶必须带签名
        Expires: expires,
    });
}

// ③ 批量给对象(或数组)的指定字段签名，原地改完返回
function signFields(input, fields, expires = DEFAULT_EXPIRES) {
    if (!input) return input;
    const arr = Array.isArray(input) ? input : [input];
    for (const item of arr) {
        if (!item) continue;
        for (const f of fields) {
            if (item[f]) item[f] = getSignedUrl(item[f], expires);
        }
    }
    return input;
}

module.exports = { uploadBuffer, getObjectBuffer, objectExists, copyObjectKey, getSignedUrl, signFields, DEFAULT_EXPIRES };