/**
 * 获取规范化客户端 IP（依赖 app.set("trust proxy", 1) 后由 Express 解析的 req.ip）
 * 避免直接信任客户端伪造的 X-Forwarded-For 首段，并截断到 45 字符以适配 VARCHAR(45)。
 */
function getClientIp(req, fallback = "") {
  const raw = req?.ip || req?.socket?.remoteAddress || fallback || "";
  const cleaned = String(raw).replace(/^::ffff:/, "").trim();
  return cleaned.slice(0, 45);
}

module.exports = { getClientIp };

