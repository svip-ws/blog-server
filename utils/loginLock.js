/**
 * 登录失败临时锁定（进程内，按「账号 + IP」维度）
 * 同一账号在同一 IP 下连续失败达到阈值后，在锁定窗口内直接拒绝登录尝试。
 *
 * 单实例进程内生效；多实例部署时需外置到 Redis / 数据库。
 */
const locks = new Map();

const MAX_FAILURES = 5;                 // 连续失败 5 次
const LOCK_WINDOW_MS = 15 * 60 * 1000;  // 统计窗口与锁定时长：15 分钟
const CLEANUP_INTERVAL = 5 * 60 * 1000;

const timer = setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of locks) {
    if (rec.lockUntil < now && now - rec.firstAt > LOCK_WINDOW_MS) {
      locks.delete(key);
    }
  }
}, CLEANUP_INTERVAL);
if (typeof timer.unref === "function") timer.unref();

/** 查询当前锁定状态 */
function getStatus(key) {
  const rec = locks.get(key);
  const now = Date.now();
  if (rec && rec.lockUntil > now) {
    return { locked: true, retryAfterMs: rec.lockUntil - now, failures: rec.count };
  }
  return { locked: false, retryAfterMs: 0, failures: rec ? rec.count : 0 };
}

/** 记录一次失败，返回最新计数与是否触发锁定 */
function recordFailure(key) {
  const now = Date.now();
  let rec = locks.get(key);
  if (!rec || now - rec.firstAt > LOCK_WINDOW_MS) {
    rec = { count: 0, firstAt: now, lockUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= MAX_FAILURES) {
    rec.lockUntil = now + LOCK_WINDOW_MS;
  }
  locks.set(key, rec);
  return {
    count: rec.count,
    locked: rec.lockUntil > now,
    retryAfterMs: Math.max(0, rec.lockUntil - now),
  };
}

/** 登录成功后清除计数 */
function clear(key) {
  locks.delete(key);
}

module.exports = {
  getStatus,
  recordFailure,
  clear,
  MAX_FAILURES,
  LOCK_WINDOW_MS,
};
