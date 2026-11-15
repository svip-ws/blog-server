// JWT 安全配置与密钥校验
const crypto = require("crypto");

const isProd = process.env.NODE_ENV === "production";

let devFallbackSecret = null;

/**
 * 获取 JWT 签名 / 校验密钥
 * - 必须通过环境变量 JWT_SECRET 配置，且长度不少于 16 位
 * - 生产环境缺失或过短时直接抛错（fail-closed，拒绝签发与校验）
 * - 开发环境缺失时生成「进程级一次性随机密钥」，仅用于本地调试，
 *   重启后所有登录态失效，绝不能用于生产
 */
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length >= 16) return secret;

  if (isProd) {
    throw new Error(
      "安全配置缺失：生产环境必须通过环境变量 JWT_SECRET 设置足够长度（建议 >= 32 位）的随机密钥"
    );
  }

  if (!devFallbackSecret) {
    devFallbackSecret = crypto.randomBytes(32).toString("hex");
    console.warn(
      "[security] 未配置 JWT_SECRET，开发环境使用一次性随机密钥（重启后登录态失效；生产环境必须通过环境变量配置）"
    );
  }
  return devFallbackSecret;
}

module.exports = { getJwtSecret, isProd };
