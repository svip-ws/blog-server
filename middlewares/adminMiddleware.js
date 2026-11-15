const { isAdmin } = require("../utils/role");

// 管理员权限校验：统一走 utils/role.isAdmin，避免各处各判一套
module.exports = (req, res, next) => {
  if (!req.user || !isAdmin(req.user.role)) {
    return res.status(403).json({
      code: 403,
      message: "权限不足，请使用管理员账号登录",
    });
  }
  next();
};
