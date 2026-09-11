// JWT 密钥策略回归测试：确保 jwtSecret() 不再回退到公开默认值
// 背景：旧实现在 env.JWT_SECRET 缺失时回退到硬编码 "dev-secret-change-me"，
// 而代码是公开仓库 —— 任何人都能自签 token 冒充任意用户（含站长）。
// 修复后：缺失/过短/等于占位串一律抛错，仅显式设置 ALLOW_INSECURE_DEV_JWT=1 才放行。
// 用法：node scripts/verify-jwt-secret.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jwtSecret } from "../functions/api/_lib/auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const FALLBACK = "dev-secret-change-me";

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}
function throws(fn) {
  try { fn(); return null; }
  catch (e) { return e; }
}

console.log("\n[1] 未配置 / 不合法时应抛错（拒绝服务，而非降级）");
for (const [label, env] of [
  ["env 为 undefined", undefined],
  ["env 为空对象", {}],
  ["JWT_SECRET 为空串", { JWT_SECRET: "" }],
  ["JWT_SECRET 为 null", { JWT_SECRET: null }],
  ["JWT_SECRET 为非字符串", { JWT_SECRET: 12345 }],
  ["JWT_SECRET 过短（10 字符）", { JWT_SECRET: "abcdefghij" }],
  ["JWT_SECRET 恰好 15 字符", { JWT_SECRET: "a".repeat(15) }],
  ["JWT_SECRET 就是公开占位串", { JWT_SECRET: FALLBACK }],
]) {
  const e = throws(() => jwtSecret(env));
  check(label + " → 抛错", !!e, e ? "已抛错" : "未抛错，返回了 " + JSON.stringify(jwtSecret(env)));
}

console.log("\n[2] 合法密钥应原样返回");
for (const len of [16, 32, 64]) {
  const secret = "k".repeat(len);
  check(`${len} 字符密钥 → 返回`, jwtSecret({ JWT_SECRET: secret }) === secret, jwtSecret({ JWT_SECRET: secret }));
}

console.log("\n[3] 显式开发逃生门");
{
  check("ALLOW_INSECURE_DEV_JWT=1 且无密钥 → 返回占位串（本地调试）",
    jwtSecret({ ALLOW_INSECURE_DEV_JWT: "1" }) === FALLBACK, jwtSecret({ ALLOW_INSECURE_DEV_JWT: "1" }));
  check('ALLOW_INSECURE_DEV_JWT="true"（非 "1"）→ 仍抛错',
    !!throws(() => jwtSecret({ ALLOW_INSECURE_DEV_JWT: "true" })));
  const strong = "s".repeat(40);
  check("同时存在强密钥与逃生门 → 优先用强密钥",
    jwtSecret({ JWT_SECRET: strong, ALLOW_INSECURE_DEV_JWT: "1" }) === strong);
}

console.log("\n[4] 占位串不得出现在 auth.js 之外（防止有人把回退逻辑写回别处）");
{
  const self = fileURLToPath(import.meta.url);
  const fallbackFiles = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".git") walk(p); }
      else if (/\.(js|mjs)$/.test(e.name)) {
        if (path.resolve(p) === path.resolve(self)) continue; // 跳过本测试文件自身
        if (fs.readFileSync(p, "utf8").includes(FALLBACK)) fallbackFiles.push(path.relative(root, p));
      }
    }
  };
  walk(path.join(root, "functions"));
  walk(path.join(root, "scripts"));
  check("仅 auth.js 引用占位串", fallbackFiles.length === 1 && /auth\.js$/.test(fallbackFiles[0]),
    JSON.stringify(fallbackFiles));
}

console.log("\n[5] 端到端：/api/me 不再接受用公开默认密钥自签的 token");
{
  const { onRequest } = await import("../functions/api/me.js");

  // 用指定密钥签发一个 token（结构与 login.js 一致：sub/name/exp）
  async function forge(username, secret) {
    const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify({ sub: username, name: username, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${Buffer.from(new Uint8Array(sig)).toString("base64url")}`;
  }
  const callMe = async (token, env) => {
    const req = new Request("https://blog-6p3.pages.dev/api/me", { headers: { Cookie: `auth=${token}` } });
    const res = await onRequest({ request: req, env });
    return await res.json();
  };

  const strong = "S".repeat(48);

  // 场景 A：线上未配置密钥（修复前会接受伪造 token）——修复后应视为未登录
  const forgedWithFallback = await forge("attacker", FALLBACK);
  const a = await callMe(forgedWithFallback, { BLOG_OWNER: "owner" });
  check("env 无 JWT_SECRET + 默认密钥自签 token → user 为 null（不再被接受）",
    a && a.user === null, JSON.stringify(a));

  // 场景 B：线上已配置密钥，但攻击者仍用旧默认密钥自签 → 必须验签失败
  const b = await callMe(forgedWithFallback, { JWT_SECRET: strong, BLOG_OWNER: "owner" });
  check("env 有强密钥 + 默认密钥自签 token → user 为 null（旧 token 全部失效）",
    b && b.user === null, JSON.stringify(b));

  // 场景 C：正常签发（用真实密钥）仍应登录成功，确认没把正常流程改坏
  const ok = await callMe(await forge("owner", strong), { JWT_SECRET: strong, BLOG_OWNER: "owner" });
  check("env 有强密钥 + 用该密钥正常签发 → 登录成功且识别为站长",
    !!(ok && ok.user && ok.user.username === "owner" && ok.user.isOwner === true), JSON.stringify(ok));
}

console.log("\n" + (fail === 0 ? `✅ 全部通过（${pass} 项）` : `❌ ${fail} 项失败 / 共 ${pass + fail} 项`));
process.exitCode = fail === 0 ? 0 : 1;
