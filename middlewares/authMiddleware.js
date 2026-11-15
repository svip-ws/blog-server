const jwt = require("jsonwebtoken");
const db = require("../config/db");
const { normalizeRole } = require("../utils/role");
const { getJwtSecret } = require("../config/security");

module.exports = async (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader
    ? authHeader.replace(/^(?:Bearer\s+)+/i, "").trim()
    : "";

  if (!token) {
    return res
      .status(401)
      .json({ code: 401, message: "拒绝访问：未登录或未携带有效凭证" });
  }

  try {
    const decoded = jwt.verify(
      token,
      getJwtSecret()
    );

    // 实时查验数据库中用户账号状态、最新角色与 Token 版本
    const [users] = await db.query(
      "SELECT id, username, role, status, token_version FROM user WHERE id = ?",
      [decoded.id]
    );

    if (users.length === 0) {
      return res.status(401).json({ code: 401, message: "账号不存在，请重新登录" });
    }

    const user = users[0];

    // 如果账号已被冻结/禁用
    if (user.status === 0) {
      return res.status(403).json({
        code: 403,
        message: "账号已被冻结/禁用，无法继续使用该服务，请联系管理员",
      });
    }

    // 校验 Token 版本号：密码更新或管理员重置后，历史设备 Token 立即失效
    if (user.token_version !== undefined && user.token_version !== null) {
      const tokenVer = Number(decoded.token_version || 0);
      if (tokenVer < Number(user.token_version)) {
        return res.status(401).json({
          code: 401,
          message: "登录凭证已失效（账号安全信息已更新），请重新登录",
        });
      }
    }

    // 重新挂载最新归一化信息
    req.user = {
      id: user.id,
      username: user.username,
      role: normalizeRole(user.role),
      status: user.status,
      token_version: user.token_version,
    };

    next();
  } catch (error) {
    return res
      .status(401)
      .json({ code: 401, message: "登录凭证失效或已过期，请重新登录" });
  }
};
