const db = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { normalizeRole } = require("../utils/role");
const { getJwtSecret, isProd } = require("../config/security");
const loginLock = require("../utils/loginLock");
const { validatePasswordStrength } = require("../utils/passwordPolicy");
const path = require("path");
const sharp = require("sharp");
const storage = require("../services/storage");
const { getClientIp } = require("../utils/clientIp");
const { cleanPlainText } = require("../utils/sanitizeHtml");
const { processAndStoreImage } = require("../utils/imageProcessor");

function sanitizeAvatarUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  const v = raw.trim().slice(0, 500);
  if (!v || v.startsWith("wxfile://") || v.startsWith("http://tmp/")) return null;
  if (/^https?:\/\//i.test(v) || v.startsWith("/") || /^[a-z0-9/_-]+\.[a-z0-9]+$/i.test(v)) {
    return v;
  }
  return null;
}

// 用户注册
exports.register = async (req, res) => {
  let { username, password, nickname } = req.body;

  username = typeof username === "string" ? username.trim() : "";
  password = typeof password === "string" ? password : "";

  if (!username || !password) {
    return res.status(400).json({ code: 400, message: "用户名和密码不能为空" });
  }

  // 账号正则规则：3-20 位字母、数字、下划线或中文
  const usernameRegex = /^[a-zA-Z0-9_\u4e00-\u9fa5]{3,20}$/;
  if (!usernameRegex.test(username)) {
    return res.status(400).json({
      code: 400,
      message: "用户名格式不合法：需 3~20 位字母、数字、下划线或中文",
    });
  }

  // 密码复杂度与强度校验（至少 8 位，包含英文字母与数字，拦截弱密码与用户名相同）
  const pwdCheck = validatePasswordStrength(password, username, "user");
  if (!pwdCheck.valid) {
    return res.status(400).json({
      code: 400,
      message: pwdCheck.message,
    });
  }

  try {
    const [existingUser] = await db.query(
      "SELECT id FROM user WHERE username = ?",
      [username],
    );

    if (existingUser.length > 0) {
      return res.status(400).json({ code: 400, message: "用户名已存在，请换一个" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const defaultNickname =
      (typeof nickname === "string" && nickname.trim()) ||
      `书友_${Math.floor(Math.random() * 90000 + 10000)}`;
    const sql =
      "INSERT INTO user (username, password, nickname, role, status) VALUES (?, ?, ?, 'user', 1)";
    await db.query(sql, [username, hashedPassword, defaultNickname]);

    res.status(201).json({ code: 201, message: "注册成功！" });
  } catch (error) {
    console.error("注册错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 用户登录
exports.login = async (req, res) => {
  let { username, password } = req.body;

  username = typeof username === "string" ? username.trim() : "";
  password = typeof password === "string" ? password : "";

  if (!username || !password) {
    return res.status(400).json({ code: 400, message: "请输入用户名和密码" });
  }

  try {
    // 登录失败临时锁定（账号 + IP 双维度聚合），防止在线暴力破解
    const loginIp = getClientIp(req, "127.0.0.1") || "127.0.0.1";
    const lockKey = username.toLowerCase() + ":" + loginIp;
    const accLockKey = "acc:" + username.toLowerCase();

    const lockStatus = loginLock.getStatus(lockKey);
    const accLockStatus = loginLock.getStatus(accLockKey);
    if (lockStatus.locked || accLockStatus.locked) {
      const waitMs = Math.max(lockStatus.retryAfterMs, accLockStatus.retryAfterMs);
      const waitMin = Math.max(1, Math.ceil(waitMs / 60000));
      return res.status(429).json({
        code: 429,
        message: `登录失败次数过多，账号已临时锁定，请 ${waitMin} 分钟后再试`,
      });
    }

    const [users] = await db.query(
      "SELECT id, username, password, role, status, avatar, nickname, points, token_version, failed_attempts, lock_until FROM user WHERE username = ?",
      [username]
    );
    if (users.length === 0) {
      // 避免时间差侧信道枚举，进行同级别密码哈希消耗（合法 60 字符 bcrypt 哈希）
      await bcrypt.compare(password, "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy");
      return res.status(401).json({ code: 401, message: "用户名或密码错误" });
    }

    const user = users[0];

    // 检查账号状态：若 status === 0 (已冻结/禁用)
    if (user.status === 0) {
      return res.status(403).json({
        code: 403,
        message: "当前账号已被冻结/禁用，无法登录，请联系系统管理员处理",
      });
    }

    // 检查数据库级账号锁定状态（分布式多实例/重启仍有效，跨 IP 撞库无效）
    if (user.lock_until && new Date(user.lock_until).getTime() > Date.now()) {
      const waitMin = Math.max(1, Math.ceil((new Date(user.lock_until).getTime() - Date.now()) / 60000));
      return res.status(429).json({
        code: 429,
        message: `账号因多次密码错误已被临时锁定，请在 ${waitMin} 分钟后再试`,
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      const fail = loginLock.recordFailure(lockKey);
      loginLock.recordFailure(accLockKey);

      const nextFailed = (user.failed_attempts || 0) + 1;
      if (nextFailed >= 5 || fail.locked) {
        await db.query(
          "UPDATE user SET failed_attempts = ?, lock_until = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?",
          [nextFailed, user.id]
        );
        return res.status(429).json({
          code: 429,
          message: "密码连续错误已达 5 次，账号已被临时锁定 15 分钟，请稍后再试",
        });
      } else {
        await db.query(
          "UPDATE user SET failed_attempts = ? WHERE id = ?",
          [nextFailed, user.id]
        );
        const remaining = 5 - nextFailed;
        return res.status(401).json({
          code: 401,
          message: `用户名或密码错误，还可重试 ${remaining} 次`,
        });
      }
    }

    // 登录成功：清零失败计数与解锁时间，记录最后登录时间与IP
    loginLock.clear(lockKey);
    loginLock.clear(accLockKey);
    const clientIp = getClientIp(req, "127.0.0.1") || "127.0.0.1";

    await db.query(
      "UPDATE user SET failed_attempts = 0, lock_until = NULL, last_login_at = NOW(), last_login_ip = ? WHERE id = ?",
      [clientIp, user.id],
    );

    // 角色归一化为规范字符串（'admin' / 'user'），token 与响应体口径一致
    const role = normalizeRole(user.role);

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role,
        token_version: user.token_version || 1,
      },
      getJwtSecret(),
      { expiresIn: "24h" },
    );

    res.json({
      code: 200,
      message: "登录成功！",
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          nickname: user.nickname,
          avatar: user.avatar,
          avatar_url: storage.sign(user.avatar),
          role,
          status: user.status,
          points: user.points,
        },
      },
    });
  } catch (error) {
    console.error("登录错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 微信快捷登录 (/api/user/wx-login)
exports.wxLogin = async (req, res) => {
  const { code, nickname, avatar, guestId } = req.body;

  if (!code) {
    return res.status(400).json({ code: 400, message: "缺少微信授权 code" });
  }

  try {
    let openid = null;
    const appId = process.env.WX_APPID || "wx401ab961e4ad5800";
    const appSecret = process.env.WX_SECRET;

    // 生产环境若未配置 WX_SECRET，禁止使用「code 哈希当 openid」的开发保底逻辑（该逻辑可被客户端伪造身份）
    if (!appSecret && isProd) {
      return res.status(503).json({
        code: 503,
        message: "微信登录未在服务端配置 WX_SECRET，已在生产环境禁用",
      });
    }

    // 请求微信接口换取 session_key 与 openid
    if (appId && appSecret) {
      try {
        const wxUrl = `https://api.weixin.qq.com/sns/jscode2session?appid=${appId}&secret=${appSecret}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
        const wxRes = await fetch(wxUrl);
        const wxData = await wxRes.json();
        if (wxData && wxData.openid) {
          openid = wxData.openid;
        } else {
          console.warn("微信官方换取 openid 响应:", wxData);
          if (isProd) {
            return res.status(401).json({
              code: 401,
              message: wxData?.errmsg ? `微信授权失败: ${wxData.errmsg}` : "微信授权凭证无效或已过期",
            });
          }
        }
      } catch (wxErr) {
        console.warn("请求微信接口异常:", wxErr.message);
        if (isProd) {
          return res.status(502).json({
            code: 502,
            message: "微信授权服务暂时不可用，请稍后重试",
          });
        }
      }
    }

    // 生产环境未获取到真实 openid 时直接拒绝，防止伪造身份
    if (!openid) {
      if (isProd) {
        return res.status(401).json({
          code: 401,
          message: "微信授权失败，未获取到有效微信身份凭据",
        });
      }
      console.warn("[security] 微信登录使用开发保底 openid，仅限本地调试，生产环境必须配置 WX_SECRET");
      const crypto = require("crypto");
      const hash = crypto.createHash("sha256").update(String(code)).digest("hex").slice(0, 24);
      openid = `wx_openid_${hash}`;
    }

    // 查询 openid 是否已绑定用户
    const [existingUsers] = await db.query(
      "SELECT id, username, openid, nickname, avatar, role, status, points, token_version FROM user WHERE openid = ?",
      [openid]
    );

    let user;
    const clientIp = getClientIp(req, "127.0.0.1") || "127.0.0.1";
    const safeWxNickname = nickname ? cleanPlainText(String(nickname)).trim().slice(0, 64) : "";
    const safeWxAvatar = sanitizeAvatarUrl(avatar);

    if (existingUsers.length > 0) {
      user = existingUsers[0];

      if (user.status === 0) {
        return res.status(403).json({
          code: 403,
          message: "该微信绑定的账号已被冻结/禁用，请联系系统管理员",
        });
      }

      // 动态更新昵称、头像（若提供了合法路径）以及最近登录时间
      const updates = ["last_login_at = NOW()", "last_login_ip = ?"];
      const updateParams = [clientIp];

      if (safeWxNickname && safeWxNickname !== "微信用户" && safeWxNickname !== user.nickname) {
        updates.push("nickname = ?");
        updateParams.push(safeWxNickname);
        user.nickname = safeWxNickname;
      }
      if (safeWxAvatar && safeWxAvatar !== user.avatar) {
        updates.push("avatar = ?");
        updateParams.push(safeWxAvatar);
        user.avatar = safeWxAvatar;
      }

      updateParams.push(user.id);
      await db.query(`UPDATE user SET ${updates.join(", ")} WHERE id = ?`, updateParams);
    } else {
      // 新用户自动注册
      const suffix = openid.replace(/^wx_openid_/, "").slice(-6);
      let username = `wx_${suffix}`;
      const [dup] = await db.query("SELECT id FROM user WHERE username = ?", [username]);
      if (dup.length > 0) {
        username = `wx_${suffix}_${Math.floor(Math.random() * 900 + 100)}`;
      }

      const defaultNickname = safeWxNickname || `微信用户_${suffix}`;
      const defaultAvatar = safeWxAvatar;

      const [insertRes] = await db.query(
        "INSERT INTO user (username, openid, nickname, avatar, role, status, points, create_time, last_login_at, last_login_ip) VALUES (?, ?, ?, ?, 'user', 1, 100, NOW(), NOW(), ?)",
        [username, openid, defaultNickname, defaultAvatar, clientIp]
      );

      user = {
        id: insertRes.insertId,
        username,
        openid,
        nickname: defaultNickname,
        avatar: defaultAvatar,
        role: "user",
        status: 1,
        points: 100,
        token_version: 1,
      };
    }

    // 关联游客历史会话
    if (guestId) {
      try {
        await db.query(
          "UPDATE ai_conversations SET user_id = ?, guest_id = NULL WHERE guest_id = ? AND (user_id IS NULL OR user_id = ?)",
          [user.id, guestId, user.id]
        );
      } catch (convErr) {
        console.warn("绑定游客会话数据提示:", convErr.message);
      }
    }

    // 签发 JWT Token
    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: normalizeRole(user.role),
        token_version: user.token_version || 1,
      },
      getJwtSecret(),
      { expiresIn: "30d" }
    );

    return res.json({
      code: 200,
      message: "微信一键登录成功！",
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          openid: user.openid,
          nickname: user.nickname,
          avatar: user.avatar,
          avatar_url: storage.sign(user.avatar),
          role: normalizeRole(user.role),
          points: user.points || 100,
        },
      },
    });
  } catch (error) {
    console.error("微信授权快捷登录出错:", error);
    return res.status(500).json({ code: 500, message: "服务器内部处理异常" });
  }
};

// 获取当前登录用户信息
exports.getUserInfo = async (req, res) => {
  try {
    const [users] = await db.query(
      "SELECT id, username, openid, nickname, avatar, role, status, bio, points, create_time, last_login_at FROM user WHERE id = ?",
      [req.user.id],
    );

    if (users.length === 0) {
      return res.status(404).json({ code: 404, message: "用户不存在" });
    }

    storage.attachUrls(users[0], { avatar: "avatar_url" });
    res.json({
      code: 200,
      message: "获取成功",
      data: users[0],
    });
  } catch (error) {
    console.error("获取用户信息错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 用户列表（分页与筛选）
exports.getUserList = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 10));
    const username = req.query.username;
    const offset = (page - 1) * pageSize;

    let querySql = `
      SELECT id, username, openid, nickname, avatar, role, status, points, last_login_at, last_login_ip, failed_attempts, create_time
      FROM user
      WHERE 1 = 1
    `;
    let countSql = `SELECT COUNT(*) AS total FROM user WHERE 1 = 1`;
    let queryParams = [];
    let countParams = [];

    // 用户名模糊筛选
    if (username) {
      querySql += ` AND username LIKE ?`;
      countSql += ` AND username LIKE ?`;
      queryParams.push(`%${username}%`);
      countParams.push(`%${username}%`);
    }

    querySql += ` ORDER BY create_time DESC LIMIT ? OFFSET ?`;
    queryParams.push(pageSize, offset);

    const [countResult, listResult] = await Promise.all([
      db.query(countSql, countParams),
      db.query(querySql, queryParams),
    ]);

    const total = countResult[0][0].total;

    storage.attachUrls(listResult[0], { avatar: "avatar_url" });
    res.json({
      code: 200,
      message: "获取成功",
      data: {
        list: listResult[0],
        total: total,
        page: page,
        pageSize: pageSize,
        totalPage: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    console.error("获取用户列表错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 单条用户信息
exports.getUserById = async (req, res) => {
  const { id } = req.params;

  try {
    const [users] = await db.query(
      "SELECT id, username, openid, nickname, avatar, role, points, status, create_time FROM user WHERE id = ?",
      [id],
    );

    if (users.length === 0) {
      return res.status(404).json({ code: 404, message: "用户不存在" });
    }

    storage.attachUrls(users[0], { avatar: "avatar_url" });
    res.json({
      code: 200,
      message: "获取成功",
      data: users[0],
    });
  } catch (error) {
    console.error("获取用户详情错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 新增管理员
exports.createUser = async (req, res) => {
  const { username, password, nickname, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ code: 400, message: "用户名和密码不能为空" });
  }

  try {
    const [existing] = await db.query(
      "SELECT id FROM user WHERE username = ?",
      [username],
    );

    if (existing.length > 0) {
      return res.status(400).json({ code: 400, message: "用户名已存在" });
    }

    const pwdCheck = validatePasswordStrength(password, username, role);
    if (!pwdCheck.valid) {
      return res.status(400).json({ code: 400, message: pwdCheck.message });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const defaultNickname =
      nickname || `用户_${Math.floor(Math.random() * 90000 + 10000)}`;

    await db.query(
      "INSERT INTO user (username, password, nickname, role) VALUES (?, ?, ?, ?)",
      [username, hashedPassword, defaultNickname, normalizeRole(role)],
    );

    res.status(201).json({ code: 201, message: "用户创建成功" });
  } catch (error) {
    console.error("创建用户错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 修改管理员信息
exports.updateUser = async (req, res) => {
  const { id } = req.params;
  const { nickname, role, password } = req.body;

  if (!nickname) {
    return res.status(400).json({ code: 400, message: "昵称不能为空" });
  }

  try {
    const [users] = await db.query("SELECT id, username FROM user WHERE id = ?", [id]);

    if (users.length === 0) {
      return res.status(404).json({ code: 404, message: "用户不存在" });
    }

    const safeRole = normalizeRole(role);

    // 防自我降级保护：防止管理员误把自己的角色改成普通用户
    if (parseInt(id) === req.user.id && safeRole !== "admin") {
      return res.status(400).json({
        code: 400,
        message: "安全保护拦截：不能取消自身当前账号的管理员角色",
      });
    }

    // 如果传了密码，就一起更新，并递增 token_version 使目标用户所有旧 Token 立即失效
    if (password) {
      const pwdCheck = validatePasswordStrength(password, users[0].username, safeRole);
      if (!pwdCheck.valid) {
        return res.status(400).json({ code: 400, message: pwdCheck.message });
      }
      const hashedPassword = await bcrypt.hash(password, 10);
      await db.query(
        "UPDATE user SET nickname = ?, role = ?, password = ?, token_version = token_version + 1 WHERE id = ?",
        [nickname, safeRole, hashedPassword, id],
      );
    } else {
      await db.query("UPDATE user SET nickname = ?, role = ? WHERE id = ?", [
        nickname,
        safeRole,
        id,
      ]);
    }

    res.json({ code: 200, message: "用户信息更新成功" });
  } catch (error) {
    console.error("更新用户错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 切换账号状态（启用/禁用）
exports.toggleUserStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const targetStatus = status === 1 || status === '1' ? 1 : 0;

  try {
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({
        code: 400,
        message: "安全保护拦截：不能禁用当前登录的管理员账号",
      });
    }

    const [users] = await db.query("SELECT id FROM user WHERE id = ?", [id]);
    if (users.length === 0) {
      return res.status(404).json({ code: 404, message: "用户不存在" });
    }

    await db.query("UPDATE user SET status = ?, failed_attempts = 0 WHERE id = ?", [
      targetStatus,
      id,
    ]);

    const msg = targetStatus === 1 ? "账号解封成功" : "账号禁用/冻结成功";
    res.json({ code: 200, message: msg, data: { status: targetStatus } });
  } catch (error) {
    console.error("切换账号状态错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 删除用户
exports.deleteUser = async (req, res) => {
  const { id } = req.params;

  try {
    if (parseInt(id) === req.user.id) {
      return res
        .status(400)
        .json({ code: 400, message: "不能删除当前登录的管理员账号" });
    }

    const [result] = await db.query("DELETE FROM user WHERE id = ?", [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ code: 404, message: "用户不存在" });
    }

    res.json({ code: 200, message: "用户删除成功" });
  } catch (error) {
    console.error("删除用户错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 获取站长公开信息
exports.getAdminInfo = async (req, res) => {
  try {
    const [users] = await db.query(
      "SELECT id, nickname, avatar, create_time FROM user WHERE role = 'admin' LIMIT 1",
    );

    if (users.length === 0) {
      return res.status(404).json({ code: 404, message: "未找到管理员信息" });
    }

    storage.attachUrls(users[0], { avatar: "avatar_url" });
    res.json({
      code: 200,
      message: "获取成功",
      data: users[0],
    });
  } catch (error) {
    console.error("获取管理员信息错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 获取个人主页信息
exports.getUserProfile = async (req, res) => {
  try {
    const [users] = await db.query(
      "SELECT id, username, nickname, avatar, role, bio, points, create_time FROM user WHERE id = ?",
      [req.user.id],
    );

    if (users.length === 0) {
      return res.status(404).json({ code: 404, message: "用户不存在" });
    }

    // 统计用户数据
    const [articleCount] = await db.query(
      "SELECT COUNT(*) AS count FROM article WHERE user_id = ?",
      [req.user.id],
    );
    const [commentCount] = await db.query(
      "SELECT COUNT(*) AS count FROM comment WHERE user_id = ?",
      [req.user.id],
    );

    const user = users[0];
    user.article_count = articleCount[0].count;
    user.comment_count = commentCount[0].count;

    storage.attachUrls(user, { avatar: "avatar_url" });
    res.json({
      code: 200,
      message: "获取成功",
      data: user,
    });
  } catch (error) {
    console.error("获取用户主页信息错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 获取用户发布的文章列表
exports.getUserArticles = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 10));
    const offset = (page - 1) * pageSize;

    const [countResult] = await db.query(
      "SELECT COUNT(*) AS total FROM article WHERE user_id = ?",
      [req.user.id],
    );

    const sql = `
      SELECT a.id, a.title, a.description, a.cover, a.view_count, a.like_count, a.status,
             a.reject_reason, a.reviewed_time, a.create_time,
             c.name AS category_name
      FROM article a
      LEFT JOIN category c ON a.category_id = c.id
      WHERE a.user_id = ?
      ORDER BY a.create_time DESC
      LIMIT ? OFFSET ?
    `;
    const [articles] = await db.query(sql, [req.user.id, pageSize, offset]);

    storage.attachUrls(articles, { cover: "cover_url" });
    res.json({
      code: 200,
      message: "获取成功",
      data: {
        list: articles,
        total: countResult[0].total,
        page: page,
        pageSize: pageSize,
      },
    });
  } catch (error) {
    console.error("获取用户文章错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 获取用户的评论列表
exports.getUserComments = async (req, res) => {
  try {
    const sql = `
      SELECT c.id, c.content, c.create_time,
             a.title AS article_title, a.id AS article_id
      FROM comment c
      LEFT JOIN article a ON c.article_id = a.id
      WHERE c.user_id = ?
      ORDER BY c.create_time DESC
      LIMIT 50
    `;
    const [comments] = await db.query(sql, [req.user.id]);

    res.json({
      code: 200,
      message: "获取成功",
      data: comments,
    });
  } catch (error) {
    console.error("获取用户评论错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 修改个人资料
exports.updateProfile = async (req, res) => {
  const safeNickname = cleanPlainText(String(req.body.nickname || "")).trim().slice(0, 64);
  const safeBio = cleanPlainText(String(req.body.bio || "")).trim().slice(0, 500);

  if (!safeNickname) {
    return res.status(400).json({ code: 400, message: "昵称不能为空" });
  }

  try {
    await db.query("UPDATE user SET nickname = ?, bio = ? WHERE id = ?", [
      safeNickname,
      safeBio,
      req.user.id,
    ]);

    res.json({ code: 200, message: "资料更新成功" });
  } catch (error) {
    console.error("更新个人资料错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};
// 上传头像
exports.uploadAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ code: 400, message: "请选择图片" });
    }

    const { key, url } = await processAndStoreImage(req.file, "avatar");

    await db.query("UPDATE user SET avatar = ? WHERE id = ?", [key, req.user.id]);

    res.json({
      code: 200,
      message: "头像更新成功",
      data: { key, url, avatar: key, avatar_url: storage.sign(key) },
    });
  } catch (error) {
    console.error("上传头像错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};

// 修改密码（递增 token_version 使旧 Token 失效）
exports.changePassword = async (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ code: 400, message: "请输入原密码和新密码" });
  }

  if (oldPassword === newPassword) {
    return res.status(400).json({ code: 400, message: "新密码不能与原密码相同" });
  }

  const pwdCheck = validatePasswordStrength(newPassword, req.user?.username, req.user?.role);
  if (!pwdCheck.valid) {
    return res.status(400).json({ code: 400, message: pwdCheck.message });
  }

  try {
    const [users] = await db.query("SELECT password FROM user WHERE id = ?", [
      req.user.id,
    ]);

    if (users.length === 0) {
      return res.status(404).json({ code: 404, message: "用户不存在" });
    }

    const isMatch = await bcrypt.compare(oldPassword, users[0].password);
    if (!isMatch) {
      return res.status(400).json({ code: 400, message: "原密码错误" });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await db.query(
      "UPDATE user SET password = ?, token_version = token_version + 1 WHERE id = ?",
      [hashed, req.user.id]
    );

    res.json({ code: 200, message: "密码修改成功，其他已登录设备已自动下线，请重新登录" });
  } catch (error) {
    console.error("修改密码错误:", error);
    res.status(500).json({ code: 500, message: "服务器内部错误" });
  }
};
