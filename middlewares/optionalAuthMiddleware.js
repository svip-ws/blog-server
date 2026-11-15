const jwt = require("jsonwebtoken");
const db = require("../config/db");
const { normalizeRole } = require("../utils/role");
const { getJwtSecret } = require("../config/security");

/**
 * 柔性鉴权中间件 (Optional Auth Middleware)
 * 允许未登录（无 Token、Token 无效、账号被禁用或 Token 已吊销）请求作为游客通过，并将 req.user 设为 null；
 * 若存在有效且未过期的激活账号 Token，则挂载最新 req.user 信息。
 */
const optionalAuthMiddleware = async (req, res, next) => {
  const token = req.headers["authorization"];
  req.user = null;

  if (!token) {
    return next();
  }

  // 与 authMiddleware 口径一致：斩断所有历史 "Bearer " 前缀
  const cleanToken = token.replace(/^(?:Bearer\s+)+/i, "").trim();
  if (!cleanToken) {
    return next();
  }

  try {
    const decoded = jwt.verify(cleanToken, getJwtSecret());
    const [users] = await db.query(
      "SELECT id, username, nickname, role, status, token_version FROM user WHERE id = ?",
      [decoded.id]
    );
    if (!users || users.length === 0) {
      return next();
    }

    const user = users[0];
    if (user.status === 0) {
      return next();
    }
    if (user.token_version !== undefined && user.token_version !== null) {
      const tokenVer = Number(decoded.token_version || 0);
      if (tokenVer < Number(user.token_version)) {
        return next();
      }
    }

    req.user = {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      role: normalizeRole(user.role),
      status: user.status,
      token_version: user.token_version,
    };
  } catch (err) {
    req.user = null;
  }

  next();
};

module.exports = optionalAuthMiddleware;
