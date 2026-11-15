/**
 * 游客 AI 调用额度（服务端强制，固定窗口计数）
 * 背景：游客「免费 N 次」原本只在浏览器 / 小程序的 localStorage 计数，
 * 清缓存或直接调用 API 即可绕过，会被盗刷大模型 token。这里在服务端兜底。
 *
 * 单实例进程内计数；多实例部署时需外置到 Redis / 数据库。
 */
const buckets = new Map();

const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 分钟清理一次过期键
const DAY_MS = 24 * 60 * 60 * 1000;

// 定时清扫，避免 Map 无限增长
const timer = setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(key);
  }
}, CLEANUP_INTERVAL);
if (typeof timer.unref === "function") timer.unref();

/**
 * 消耗一次额度并判定是否放行
 * @param {string} key 计数键
 * @param {number} limit 窗口内允许次数
 * @param {number} windowMs 窗口时长（毫秒）
 * @returns {{allowed:boolean, remaining:number, limit:number, resetMs:number}}
 */
function consumeQuota(key, limit, windowMs = DAY_MS) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return {
    allowed: b.count <= limit,
    remaining: Math.max(0, limit - b.count),
    limit,
    resetMs: Math.max(0, b.resetAt - now),
  };
}

module.exports = { consumeQuota, DAY_MS };
