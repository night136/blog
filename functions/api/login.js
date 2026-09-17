// 登录：POST /api/login
//
// 加固三件（audit §五）：① 人机验证 ② 失败计数 + 递增延迟 ③ PBKDF2 迭代数可安全上调。
// 这三件的关系是「互补」而不是「叠加冗余」：
//   人机验证挡批量脚本（但可能被墙/被绕过，不能当唯一防线）；
//   失败计数挡"人在慢慢试"（不依赖任何第三方服务，被墙也照常生效）；
//   迭代数决定**万一哈希库泄露**时离线爆破的单价。
import {
  verifyPassword, makePasswordHash, needsRehash, targetIterations,
  json, sessionCookie, signJWT, jwtSecret,
} from "./_lib/auth.js";
import { verifyTurnstile, getClientIp } from "./_lib/turnstile.js";
import { evaluateThrottle, recordAttempt, ipHashOf, sleep, normalizeLoginId } from "./_lib/loginGuard.js";

// ⚠️ 假哈希：用户不存在时也要走一次**完整**的 PBKDF2，否则「用户不存在」会比
//    「密码错误」快得多，攻击者据此就能枚举出哪些用户名已注册（时序侧信道）。
//
//    这个假串必须用**当前的目标格式与迭代数**，不能再用老的 "salt:hash"
//    （老格式隐含 100000 次，而真密码已经是 PBKDF2_DEFAULT_ITERATIONS 次 ——
//     假哈希比真校验快好几倍，等于把侧信道又打开）。
//    salt 用固定值即可：它在"用户不存在"的分支里本来就没有对应账号。
const DUMMY_SALT = "00000000-0000-0000-0000-000000000000";
function dummyHash(iterations) {
  // 结构形如 pbkdf2$<iter>$<salt>$<64 位 base64url 占位>
  return `pbkdf2$${iterations}$${DUMMY_SALT}$${"A".repeat(43)}`;
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.BLOG_DB) {
      return json({ error: "服务端未配置数据库（BLOG_DB），请联系站长。" }, 500);
    }

    let body;
    try { body = await request.json(); } catch (_) {
      return json({ error: "请求格式错误" }, 400);
    }
    const id = (body.username || "").trim();
    const password = body.password || "";
    if (!id || !password) return json({ error: "请输入用户名和密码" }, 400);

    // ① 人机验证。放在最前面：让脚本连一次 PBKDF2 的 CPU 都花不到我们身上。
    //    未配置 TURNSTILE_SECRET_KEY 时 verifyTurnstile 直接放行（与 register 同款行为）。
    const ts = await verifyTurnstile(body.turnstileToken, env.TURNSTILE_SECRET_KEY, getClientIp(request));
    if (!ts.success) {
      return json({ error: ts.error || "人机验证失败，请重试" }, 403);
    }

    // ② 失败计数 → 递增延迟。刻意做在"查用户之前"：
    //    这样它对**存在与不存在的用户名一视同仁**，不会变成新的枚举信号。
    const clientIp = getClientIp(request);
    let ipSalt = null;
    try { ipSalt = jwtSecret(env); } catch (_) { /* 密钥没配：退化为"不做 IP 维度计数" */ }
    const ipHash = await ipHashOf(clientIp, ipSalt);
    const throttle = await evaluateThrottle(env, { username: id, ipHash });
    if (throttle.delayMs > 0) await sleep(throttle.delayMs);

    // 同时支持用户名或邮箱登录
    const user = await env.BLOG_DB.prepare(
      "SELECT username, email, password_hash FROM users WHERE username = ? OR email = ?"
    ).bind(id, id.toLowerCase()).first();

    // ⚠️ 不区分「用户不存在」与「密码错误」：两种情况的文案必须完全一致，
    //    否则攻击者可据此枚举出哪些用户名/邮箱已注册。同理，用户不存在时也走一次
    //    假哈希校验，让响应耗时与真实校验相当。
    const iterations = targetIterations(env);
    const stored = user ? user.password_hash : dummyHash(iterations);
    const ok = await verifyPassword(password, stored);

    if (!user || !ok) {
      await recordAttempt(env, { username: id, ipHash, success: false });
      const headers = throttle.delayMs > 0 ? { "X-Login-Delay": String(throttle.delayMs) } : {};
      return json({
        error: "用户名或密码错误",
        // 只在真的开始延迟时才回传，让前端能给出"还要等几秒"的可见反馈而不是干等
        ...(throttle.delayMs > 0 ? { retryAfterMs: throttle.delayMs } : {}),
      }, 401, headers);
    }

    // ③ 顺手升级：老格式（"salt:hash"，100000 次）或迭代数低于当前目标时，
    //    用当前目标迭代数重写。用**已通过校验的明文密码**重算即可 —— 不需要用户做任何事，
    //    存量密码就在各自的下一次登录里逐个完成迁移。
    if (needsRehash(user.password_hash, iterations)) {
      try {
        const upgraded = await makePasswordHash(password, crypto.randomUUID(), iterations);
        await env.BLOG_DB.prepare(
          "UPDATE users SET password_hash = ? WHERE username = ?"
        ).bind(upgraded, user.username).run();
        console.log(`[login] 已升级 ${user.username} 的密码哈希到 ${iterations} 次`);
      } catch (e) {
        // 升级失败绝不能影响本次登录：用户凭据是对的，就该让他进去。
        console.error("[login] 密码哈希升级失败（不影响本次登录）：", e && e.stack ? e.stack : e);
      }
    }

    await recordAttempt(env, { username: id, ipHash, success: true });

    const secret = jwtSecret(env);
    const token = await signJWT(
      { sub: user.username, name: user.username, exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 },
      secret
    );
    return json(
      { ok: true, user: { username: user.username, email: user.email } },
      200,
      { "Set-Cookie": sessionCookie(token, 7 * 24 * 3600) }
    );
  } catch (e) {
    // 不回显 e.message：可能泄露表结构 / SQL 细节。仅记录到服务端日志。
    console.error("login failed:", e && e.stack ? e.stack : e);
    return json({ error: "登录失败，请稍后重试" }, 500);
  }
}

// 供守护脚本直接单测的纯逻辑出口（避免为了测一个纯函数去跑整个 HTTP 流程）
export { normalizeLoginId };
