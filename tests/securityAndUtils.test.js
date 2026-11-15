const test = require("node:test");
const assert = require("node:assert/strict");

const { getClientIp } = require("../utils/clientIp");
const { isPrivateIp, assertSafePublicUrl } = require("../utils/urlSecurity");
const { cleanArticleContent, cleanPlainText } = require("../utils/sanitizeHtml");
const { processAndStoreImage } = require("../utils/imageProcessor");

test("getClientIp normalizes IPv4-mapped IPv6 and clamps length to 45", () => {
  assert.equal(getClientIp({ ip: "::ffff:203.0.113.10" }), "203.0.113.10");
  assert.equal(getClientIp({ socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
  assert.equal(getClientIp({}, "fallback"), "fallback");
  const longIp = "2001:0db8:85a3:0000:0000:8a2e:0370:7334:extra:suffix";
  assert.equal(getClientIp({ ip: longIp }).length, 45);
});

test("isPrivateIp identifies loopback, RFC1918, CGNAT, link-local, and public IPs", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("10.20.30.40"), true);
  assert.equal(isPrivateIp("172.16.0.1"), true);
  assert.equal(isPrivateIp("172.31.255.254"), true);
  assert.equal(isPrivateIp("192.168.1.1"), true);
  assert.equal(isPrivateIp("169.254.169.254"), true);
  assert.equal(isPrivateIp("100.64.0.1"), true);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("fd12::1"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("1.1.1.1"), false);
});

test("assertSafePublicUrl blocks SSRF targets and allows valid public IPs", async () => {
  await assert.rejects(() => assertSafePublicUrl("file:///etc/passwd"), /http\/https/);
  await assert.rejects(() => assertSafePublicUrl("http://user:pass@example.com"), /认证信息/);
  await assert.rejects(() => assertSafePublicUrl("http://localhost:3001/api"), /内部或保留域名/);
  await assert.rejects(() => assertSafePublicUrl("http://169.254.169.254/latest/meta-data"), /内网或保留 IP/);
  await assert.rejects(() => assertSafePublicUrl("http://[::1]:8080/"), /内网或保留 IP/);
  const ok = await assertSafePublicUrl("https://8.8.8.8/dns-query");
  assert.equal(ok, "https://8.8.8.8/dns-query");
});

test("sanitizeHtml strips dangerous URIs and events while preserving safe markup", () => {
  const dirty =
    '<p onclick="alert(1)">Hi</p><a href="data:text/html,<script>alert(1)</script>">bad</a><a href="https://example.com">ok</a><img src="https://example.com/a.png" onerror="alert(2)">';
  const cleaned = cleanArticleContent(dirty);
  assert.doesNotMatch(cleaned, /onclick|onerror|data:text\/html|<script/i);
  assert.match(cleaned, /<a href="https:\/\/example\.com" rel="noopener noreferrer">ok<\/a>/);
  assert.match(cleaned, /<img src="https:\/\/example\.com\/a\.png" \/>/);

  assert.equal(cleanPlainText('<b>hello</b><script>x</script>'), "hello");
});

test("processAndStoreImage rejects forged GIF and WebP payloads via magic bytes", async () => {
  await assert.rejects(
    () =>
      processAndStoreImage(
        {
          originalname: "evil.gif",
          mimetype: "image/gif",
          buffer: Buffer.from("not-a-real-gif-payload"),
        },
        "articles",
      ),
    (err) => err.status === 400,
  );

  await assert.rejects(
    () =>
      processAndStoreImage(
        {
          originalname: "evil.webp",
          mimetype: "image/webp",
          buffer: Buffer.from("<html>xss</html>"),
        },
        "articles",
      ),
    (err) => err.status === 400,
  );
});
