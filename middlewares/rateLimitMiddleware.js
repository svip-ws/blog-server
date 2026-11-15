const rateLimit = require("express-rate-limit");

/**
 * 登录/注册敏感接口防爆破限流规则：
 * 15 分钟内同一 IP 最多允许 15 次请求
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 分钟
  max: 15, // 最多 15 次
  standardHeaders: true, // 返回 `RateLimit-*` 响应头
  legacyHeaders: false, // 禁用 `X-RateLimit-*` 旧响应头
  message: {
    code: 429,
    message: "频繁尝试登录/注册被拦截：请 15 分钟后再试！",
  },
});

/**
 * 通用 API 接口限流规则：
 * 15 分钟内同一 IP 最多 500 次请求
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 429,
    message: "系统请求过于频繁，请稍后再试。",
  },
});

/**
 * 留言/回复防刷限流规则：
 * 10 分钟内同一 IP 最多发表 8 条留言或回复（正常访客远达不到）
 */
const messageLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 429,
    message: "发言太频繁了，休息 10 分钟再来吧～",
  },
});

module.exports = { authLimiter, apiLimiter, messageLimiter };
