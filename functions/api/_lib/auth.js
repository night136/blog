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

// ── 密码哈希：迭代数**写进存储串**，才能在不锁死现存密码的前提下升级 ──
//
// 为什么要带迭代数（曾经的坑）：老实现把 100000 硬编码在算法里，存储串是 "salt:hash"。
// 想提高强度就只能改那个常量 —— 而一改，所有现存密码立刻全部校验失败（登录不上、
// 且没有任何办法分辨「密码错」与「格式变了」）。于是这个值事实上被**冻死**了。
//
// 现在存储串有两种形态，校验时**按存储串里写的迭代数**去算：
//   · 新：`pbkdf2$<iterations>$<salt>$<hash>`
//   · 旧：`salt:hash`  ← 隐含 100000 次，永远不会被改写，只是读得出来
// 校验成功后由调用方（login）用 needsRehash() 判断要不要顺手升级成新形态。
// 这样迭代数就变成一个**可安全上调的旋钮**：调大只影响新写入与已登录用户，
// 存量密码在用户下次登录时逐个自动迁移，全程无需任何人重置密码。
const PBKDF2_HASH = "SHA-256";
const PBKDF2_LEGACY_ITERATIONS = 100000; // 老格式 "salt:hash" 的隐含迭代数（历史事实，别改）

// 当前目标迭代数。可由环境变量 PBKDF2_ITERATIONS 覆盖（便于不改代码就上调/回滚）。
//
// 🔴 2026-09-17 事故：默认值从 100000 提到 210000（OWASP 建议值）后，线上**注册全挂**
//    （用户可见"注册失败，请稍后重试"），唯一的行为差异就是这个数字。
//    为什么"只有注册坏、登录不坏"——这条差异恰好是判据：
//      · 老用户的存储串是 `salt:hash`，校验时按串里隐含的 **100000** 算 ⇒ 登录照常；
//      · 新注册走 makePasswordHash(targetIterations) ⇒ 按 **210000** 算 ⇒ 挂在注册这一步。
//
// 🔴🔴 根因（2026-09-17 二次复测定性，推翻了首次的归因）：
//    **workerd 对 PBKDF2 的迭代数有硬上限 100000**，超过**直接抛 NotSupportedError**。
//    真边缘实测（临时只读探针，`/api/config?__hashdiag=<n>`，测完已拆除）：
//        100000 ⇒ 3/3 成功
//        100001 ⇒ 3/3 抛错：`Pbkdf2 failed: iteration counts above 100000 are not supported (requested 100001).`
//        （100500 / 101000 / 110000 / 125000 同）
//    边界精确到 **100001**，且平台在 message 里自己写出了上限值。
//    来源：workerd 源码 crypto-impl-pbkdf2.c++ 的迭代数校验；
//         cloudflare/workerd issue #1346（"100,000 iterations of PBKDF2 is insecure"）。
//    平台这么做的理由（issue 里官方原话）：**CPU 限时机制无法中断 BoringSSL 中途执行的
//    PBKDF2**，所以只能**事先**限制迭代数，而不能靠事后掐断。
//
// ⚠️ 首次归因曾写成「210000 超出 Free 档 10ms CPU 预算 ⇒ 被平台终止（Error 1102）」。
//    那个解释**能解释当时的全部观察**，所以被当成了结论 —— 但它是错的，判据一直摆在那里
//    却没人看：超预算会返回 **1102**，而实际返回的是 **1101**（Worker threw a JavaScript exception）。
//    教训：两个假设都能解释你手上的观察时，要去找**能把它们分开**的观察，而不是挑一个更"合理"的写下来。
//
//    结论（两条，都别记错）：
//    ① **迭代数上限由平台硬编码决定（当前 100000），不是由 CPU 预算推出来的** ——
//       它跟档位、跟 10ms 都没有可推导的关系，只能实测。
//    ② 100000 本身跑得没问题：真边缘连打 25/25 全部成功（且修好前用户真机注册也通了）。
//       所以这不是"踩线值"，不需要为了留余量而下调。
//    要上调只能：先真机跑通「注册 + 登录」，再用 `PBKDF2_ITERATIONS` 环境变量灰度
//    （它比改常量安全：不用重新部署就能回滚）。
export const PBKDF2_DEFAULT_ITERATIONS = 100000;
const PBKDF2_MIN_ITERATIONS = 10000;   // 低于此值的存储串视为异常，拒绝校验
const PBKDF2_MAX_ITERATIONS = 2000000; // 防御性上限：存储串被篡改成天文数字时不要试图去算

// 从环境变量解析目标迭代数；非法值一律回落到默认值（并留痕，不静默）
export function targetIterations(env) {
  const raw = env && env.PBKDF2_ITERATIONS;
  if (raw === undefined || raw === null || raw === "") return PBKDF2_DEFAULT_ITERATIONS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < PBKDF2_MIN_ITERATIONS || n > PBKDF2_MAX_ITERATIONS) {
    console.error(`[auth] PBKDF2_ITERATIONS 取值非法（${String(raw)}），已回落到 ${PBKDF2_DEFAULT_ITERATIONS}`);
    return PBKDF2_DEFAULT_ITERATIONS;
  }
  return n;
}

// PBKDF2 密码哈希（默认用当前目标迭代数），返回 base64url 的派生结果
export async function hashPassword(password, salt, iterations = PBKDF2_DEFAULT_ITERATIONS) {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations, hash: PBKDF2_HASH },
    keyMat, 256
  );
  return b64urlEncodeBytes(new Uint8Array(bits));
}

// 生成可入库的完整存储串（新格式）
export async function makePasswordHash(password, salt, iterations) {
  const h = await hashPassword(password, salt, iterations);
  return `pbkdf2$${iterations}$${salt}$${h}`;
}

// 解析存储串 → { iterations, salt, hash }；无法识别时返回 null（**不要**当成 100000 硬猜）
export function parsePasswordHash(stored) {
  const s = String(stored == null ? "" : stored);
  if (s.startsWith("pbkdf2$")) {
    const parts = s.split("$");
    if (parts.length !== 4) return null;
    const iter = Number(parts[1]);
    if (!Number.isInteger(iter) || iter < PBKDF2_MIN_ITERATIONS || iter > PBKDF2_MAX_ITERATIONS) return null;
    if (!parts[2] || !parts[3]) return null;
    return { iterations: iter, salt: parts[2], hash: parts[3] };
  }
  // 旧格式 "salt:hash"（老实现写出来的）；只在**确实有冒号且两段都非空**时认账
  const idx = s.indexOf(":");
  if (idx <= 0 || idx === s.length - 1) return null;
  return { iterations: PBKDF2_LEGACY_ITERATIONS, salt: s.slice(0, idx), hash: s.slice(idx + 1) };
}

// 校验：**按存储串里记录的迭代数**计算，所以老密码在迭代数上调后依然能通过。
// ⚠️ 解析失败（格式不认识的垃圾）返回 false，但必须与「密码错」走**同样长**的耗时路径 ——
//    调用方（login）因此不在这里做短路优化，见下方 DUMMY 说明。
export async function verifyPassword(password, stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const computed = await hashPassword(password, parsed.salt, parsed.iterations);
  return constantTimeEqual(computed, parsed.hash);
}

// 需要升级吗？（旧格式，或迭代数低于当前目标）
export function needsRehash(stored, iterations) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;                 // 解析不了的不去覆写（可能是别的算法，别毁数据）
  return parsed.iterations < iterations;
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

// 登录/留言限频用：把 IP 变成不可逆哈希，**不存原 IP**（隐私）。
// 输出是 hex 的 SHA-256(ip + "|" + secret)。secret 缺失时也照常哈希（只是不再有"加盐"作用），
// 因为调用方可能在 JWT_SECRET 未配置的环境里跑，不该因此让整个功能 500。
// ⚠️ 这个实现是从 guestbook.js 原样搬过来的（此前两处各有一份）—— 输出必须逐字节不变，
//    否则线上已存的 ip_hash 会与新增的对不上，限频窗口会突然"归零"。
export async function hashIp(ip, secret) {
  const data = new TextEncoder().encode((ip || "") + "|" + (secret || ""));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
