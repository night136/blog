// 共享认证工具（Cloudflare Pages Functions，运行于 Workers 运行时）
// 注意：以下工具被 functions/api/ 下的端点通过相对路径 import，
// 文件名以 "_" 开头，Cloudflare 不会把它当作路由。

function b64urlEncodeBytes(u8) {
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlEncodeStr(str) {
  return b64urlEncodeBytes(new TextEncoder().encode(str));
}
function b64urlDecodeStr(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(u8);
}

// PBKDF2 密码哈希，返回 { salt, hash }
export async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" },
    keyMat, 256
  );
  return b64urlEncodeBytes(new Uint8Array(bits));
}

export async function verifyPassword(password, stored) {
  // stored 形如 "salt:hash"
  const idx = stored.indexOf(":");
  if (idx < 0) return false;
  const salt = stored.slice(0, idx);
  const hash = stored.slice(idx + 1);
  const computed = await hashPassword(password, salt);
  return constantTimeEqual(computed, hash);
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function signJWT(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const h = b64urlEncodeStr(JSON.stringify(header));
  const p = b64urlEncodeStr(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64urlEncodeBytes(new Uint8Array(sig))}`;
}

export async function verifyJWT(token, secret) {
  if (!token) throw new Error("no token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("bad token");
  const [h, p, s] = parts;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${p}`));
  const sigStr = b64urlEncodeBytes(new Uint8Array(sig));
  if (!constantTimeEqual(sigStr, s)) throw new Error("bad signature");
  const payload = JSON.parse(b64urlDecodeStr(p));
  if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error("expired");
  return payload;
}

// JWT 密钥的唯一来源。所有签发（login/register）与校验（各接口）都必须走这里，
// 否则会出现「/api/me 显示已登录，但发文章提示请先登录」—— 签发与校验用了不同密钥。
//
// ⚠️ 安全：绝不能在生产环境回退到硬编码默认值。旧版本曾在 env.JWT_SECRET 缺失时
// 回退到下面这个公开字符串，而代码是公开仓库 —— 等于把签名密钥写在 README 里，
// 任何人都能自签 token 冒充任意用户（含站长）。因此这里改为「缺失即抛错」，
// 让配置问题立刻暴露，而不是静默降级到不安全状态。
const DEV_FALLBACK_SECRET = "dev-secret-change-me";
const MIN_SECRET_LEN = 16; // 128 bit 起步；建议使用 ≥32 字符的随机串

export function jwtSecret(env) {
  const secret = env && env.JWT_SECRET;
  if (typeof secret === "string" && secret.length >= MIN_SECRET_LEN && secret !== DEV_FALLBACK_SECRET) {
    return secret;
  }
  // 显式开发逃生门：仅当环境变量 ALLOW_INSECURE_DEV_JWT=1 时才允许用默认密钥。
  // 生产环境绝不要设置它 —— 必须显式选择，无法"忘记配置"而被动降级。
  if (env && env.ALLOW_INSECURE_DEV_JWT === "1") return DEV_FALLBACK_SECRET;
  throw new Error(
    "JWT_SECRET 未配置或过短（至少 " + MIN_SECRET_LEN + " 字符）：请在 Cloudflare Pages 项目 " +
    "Settings → Environment variables 配置一个随机密钥（建议 ≥32 字符）。" +
    "本地 wrangler 调试可临时设置 ALLOW_INSECURE_DEV_JWT=1。"
  );
}

export function getCookie(req, name) {
  const c = req.headers.get("Cookie") || "";
  for (const part of c.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function sessionCookie(token, maxAgeSec) {
  // maxAgeSec 为秒
  return `auth=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
}

export function clearCookie() {
  return `auth=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

// 站长判定：环境变量 BLOG_OWNER 设为站长的登录用户名后，
// 站长可管理（编辑/删除）任意文章，不受 author_username 限制。未设置则该函数恒返回 false。
export function isOwner(username, env) {
  const owner = env && env.BLOG_OWNER;
  return !!(owner && username && username === owner);
}
