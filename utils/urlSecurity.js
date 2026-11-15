const dns = require("dns").promises;
const net = require("net");

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata",
]);

function isPrivateIpv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIp(ip) {
  const normalized = String(ip || "").trim().toLowerCase();
  if (!normalized) return true;

  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice(7));
  }

  const ver = net.isIP(normalized);
  if (ver === 4) return isPrivateIpv4(normalized);
  if (ver === 6) {
    if (normalized === "::" || normalized === "::1") return true;
    // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
    if (normalized.startsWith("ff")) return true;
    return false;
  }
  return true;
}

/**
 * 校验外部网页 URL 是否为安全的公网 http(s) 目标（防 SSRF：拦截内网/回环/云元数据地址）
 */
async function assertSafePublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("无效的链接格式");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http/https 链接");
  }
  if (parsed.username || parsed.password) {
    throw new Error("链接不允许包含认证信息");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("禁止访问内部或保留域名");
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("禁止访问内网或保留 IP 地址");
    }
    return parsed.toString();
  }

  const records = await dns.lookup(hostname, { all: true });
  if (!records || records.length === 0) {
    throw new Error("无法解析目标域名");
  }
  for (const rec of records) {
    if (isPrivateIp(rec.address)) {
      throw new Error("目标域名解析到内网或保留 IP，已拦截");
    }
  }

  return parsed.toString();
}

module.exports = {
  isPrivateIp,
  assertSafePublicUrl,
};

