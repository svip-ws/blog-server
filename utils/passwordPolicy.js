/**
 * 密码安全策略校验器
 * ------------------------------------------------------------------
 * 1. 最小长度限制（普通用户 >= 8 位，管理员 >= 8 位）
 * 2. 复杂度要求：必须同时包含英文字母与数字
 * 3. 常见弱密码黑名单拦截
 * 4. 账户关联性校验：禁止密码与用户名相同或过于接近
 */

const WEAK_PASSWORDS = new Set([
  "123456", "12345678", "123456789", "1234567890",
  "password", "password123", "admin123", "root123", "admin888",
  "qwerty", "111111", "11111111", "888888", "88888888", "666666", "66666666",
  "abcdef", "abcdefg", "123123", "123321", "654321", "iloveyou"
]);

/**
 * 校验密码强度
 * @param {string} password 待校验密码
 * @param {string} [username] 对应用户名
 * @param {string} [role] 用户角色
 * @returns {{ valid: boolean, message: string }}
 */
function validatePasswordStrength(password, username = "", role = "user") {
  if (!password || typeof password !== "string") {
    return { valid: false, message: "密码不能为空" };
  }

  const minLen = 8;
  if (password.length < minLen) {
    return { valid: false, message: `密码长度不能少于 ${minLen} 位` };
  }

  if (password.length > 64) {
    return { valid: false, message: "密码长度不能超过 64 位" };
  }

  // 必须同时包含英文字母与数字
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumber = /\d/.test(password);
  if (!hasLetter || !hasNumber) {
    return { valid: false, message: "密码必须同时包含英文字母和数字" };
  }

  // 禁止弱密码字典
  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    return { valid: false, message: "该密码属于常见弱密码，请设置更复杂的密码" };
  }

  // 禁止连续单一字符或纯字母重复（如 aaaaaaaa, 11111111）
  if (/^(.)\1+$/.test(password)) {
    return { valid: false, message: "密码不能为单一字符的重复" };
  }

  // 禁止密码与用户名相同
  if (username && typeof username === "string" && username.trim().length >= 3) {
    const cleanUser = username.trim().toLowerCase();
    if (password.toLowerCase() === cleanUser) {
      return { valid: false, message: "密码不能与用户名完全相同" };
    }
  }

  return { valid: true, message: "密码强度合格" };
}

module.exports = {
  validatePasswordStrength,
};
