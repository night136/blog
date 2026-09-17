// 注册：POST /api/register
import { makePasswordHash, targetIterations, json, sessionCookie, signJWT, jwtSecret } from "./_lib/auth.js";
import { verifyTurnstile, getClientIp } from "./_lib/turnstile.js";

export async function onRequestPost({ request, env }) {
  try {
    if (!env.BLOG_DB) {
      return json({ error: "服务端未配置数据库（BLOG_DB），请联系站长。" }, 500);
    }
    // ⚠️ login 早就有这一层，register 一直没有（2026-09-17 定位故障时实测发现）：
    //    请求体不是合法 JSON 时 request.json() 会抛，被最外层 catch 兜成 **500 "注册失败，请稍后重试"** ——
    //    把「客户端发了坏请求」说成「服务端故障」，既误导用户去重试，也让排查时看不到真因。
    //    这类输入问题一律 400，与 login 口径一致。
    let body;
    try { body = await request.json(); } catch (_) {
      return json({ error: "请求格式错误" }, 400);
    }
    const username = (body.username || "").trim();
    const password = body.password || "";
    const email = (body.email || "").trim();

    if (!username || !password) return json({ error: "用户名和密码必填" }, 400);
    if (username.length < 2 || username.length > 32) return json({ error: "用户名长度需 2–32 位" }, 400);
    if (password.length < 6) return json({ error: "密码至少 6 位" }, 400);

    // Turnstile 人机验证（未配置 TURNSTILE_SECRET_KEY 时自动跳过）
    const ts = await verifyTurnstile(
      body.turnstileToken,
      env.TURNSTILE_SECRET_KEY,
      getClientIp(request)
    );
    if (!ts.success) {
      return json({ error: ts.error || "人机验证失败，请重试" }, 403);
    }

    // 先查重：绝大多数重复注册都能在这里得到友好提示（也省掉一次昂贵的 PBKDF2）。
    // ⚠️ 但这**不是**正确性的保证 —— 两个人同时注册同一个名字时，双方都会查不到，
    //    最终由 users.username 的 UNIQUE 约束兜底（见下面的 catch）。见 audit §七 #13。
    const existing = await env.BLOG_DB.prepare(
      "SELECT id FROM users WHERE username = ?"
    ).bind(username).first();
    if (existing) return json({ error: "该用户名已被注册" }, 409);

    // 尽早解析密钥：若 JWT_SECRET 未配置，应在写库之前失败，
    // 避免「用户已创建但注册返回 500，重试又提示用户名已占用」的半成品状态。
    const secret = jwtSecret(env);

    // 密码哈希带上当前目标迭代数（见 auth.js 顶部说明：迭代数写入存储串，才可安全上调）
    const pwHash = await makePasswordHash(password, crypto.randomUUID(), targetIterations(env));

    try {
      await env.BLOG_DB.prepare(
        "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)"
      ).bind(username, email || null, pwHash).run();
    } catch (e) {
      // 并发下的重复注册：查重与插入之间有窗口，靠 UNIQUE 约束兜住。
      // 这里必须把「约束冲突」翻译成 409 而不是让它冒泡成 500 —— 那是**用户输入问题**，
      // 不是服务端故障；回 500 会让人以为系统坏了并去重试，反而更乱。
      if (/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String((e && e.message) || ""))) {
        return json({ error: "该用户名已被注册" }, 409);
      }
      throw e;
    }

    const token = await signJWT(
      { sub: username, name: username, exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 },
      secret
    );
    return json(
      { ok: true, user: { username, email } },
      200,
      { "Set-Cookie": sessionCookie(token, 7 * 24 * 3600) }
    );
  } catch (e) {
    // 不回显 e.message：可能泄露表结构 / SQL 细节（与 login 口径一致）。仅记录到服务端日志。
    //
    // ⚠️ 但**服务端日志里必须留一个可检索的分类码**，不能只写一句通用文案。
    //    2026-09-17 的事故就是反面教材：用户报「注册失败，请稍后重试」，而 catch 把原因
    //    吞得干干净净（原始 message 不出响应体是**对的**，连日志里都没有分类就很难查），
    //    最后只能临时给响应体加诊断码才定位到"PBKDF2 迭代数超边缘 CPU 预算"。
    //    现在分类码只进 console.error ⇒ 既不泄漏，又能在 Cloudflare 日志里按 `[E1-cpu]` 搜。
    const msg = String((e && e.message) || e);
    const code = /CPU|exceeded|limit/i.test(msg) ? "E1-cpu"
      : /JWT_SECRET/i.test(msg) ? "E2-jwt"
      : /no such (table|column)/i.test(msg) ? "E3-schema"
      : /UNIQUE|CONSTRAINT/i.test(msg) ? "E4-unique"
      : /PBKDF2|deriveBits|iterations|NotSupported|crypto/i.test(msg) ? "E5-crypto"
      : /SQL|D1|database|storage|readonly/i.test(msg) ? "E6-db"
      : "E0-other";
    console.error(`register failed [${code}]:`, e && e.stack ? e.stack : e);
    return json({ error: "注册失败，请稍后重试" }, 500);
  }
}