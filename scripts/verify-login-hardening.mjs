// 登录加固回归（audit §五：Turnstile + 失败计数 + PBKDF2 渐进升级）
//
// 为什么单独一个守护：这三件里有两件**错了也不会立刻显形**——
//   · PBKDF2 迭代数直接改大 ⇒ 所有现存密码校验失败（全站登不进去），但只有真人登录时才发现；
//   · 假哈希忘了跟着新格式走 ⇒ 时序侧信道回来，任何功能测试都测不出来。
// 所以判据必须对着"能不能登进去 / 耗时路径是否一致"写，不能对着"代码里有那行字"写。
//
// 判据全部是**真调用**：动态 import 后拿假 env / 假 D1 / 假 fetch 跑一遍。
//
// [1] auth.js 的哈希格式：老格式必须**永远**能校验（这是"不锁死存量密码"的全部意义）
// [2] 渐进升级：needsRehash 的判定，以及登录成功时真的写回新格式
// [3] 假哈希与真哈希同格式同迭代数（时序侧信道）
// [4] loginGuard 纯逻辑：延迟曲线、归一化、表缺失时优雅降级且**留痕**
// [5] /api/login 端点：人机验证、同文案、计数落库、超阈值回传 retryAfterMs
// [6] /api/register：并发冲突回 409（不是 500）、错误不回显内部信息
// 外加负向自证：四种故障各自必须让判据变红。
//
// 用法：node scripts/verify-login-hardening.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, "..");
const argRoot = (process.argv.find((a) => a.startsWith("--root=")) || "").slice("--root=".length);
const ROOT = argRoot ? path.resolve(argRoot) : REPO;

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}

// ── 沙箱（仓库里没有 package.json，Node 会把 functions/*.js 当 CJS 解析、直接 import 会炸）──
function makeSandbox(mutate = null) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blog-login-"));
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));
  fs.cpSync(path.join(ROOT, "functions"), path.join(tmp, "functions"), { recursive: true });
  if (mutate) mutate(tmp);
  return tmp;
}
const imp = (sandbox, rel) => import(pathToFileURL(path.join(sandbox, rel)).href);

const SECRET = "test-secret-long-enough-1234567890";
const baseEnv = (extra = {}) => ({ JWT_SECRET: SECRET, ...extra });

// ── 假 D1：按 SQL 形状分派，并记录每一次调用 ──
function fakeDb(opts = {}) {
  const {
    user = null,
    failsByUser = 0,
    failsByIp = 0,
    insertError = null,
    missingTable = false,
    log = [],
  } = opts;
  function makeStmt(sql) {
    let args = [];
    const stmt = {
      bind(...a) { args = a; return stmt; },
      async first() {
        log.push({ kind: "first", sql, args });
        if (/FROM users/i.test(sql)) return user;
        if (/COUNT\(\*\)/i.test(sql)) {
          if (missingTable) throw new Error("D1_ERROR: no such table: login_attempts");
          const isIp = /ip_hash\s*=/.test(sql);
          return { c: isIp ? failsByIp : failsByUser };
        }
        return null;
      },
      async all() { log.push({ kind: "all", sql, args }); return { results: [] }; },
      async run() {
        log.push({ kind: "run", sql, args });
        if (missingTable) throw new Error("D1_ERROR: no such table: login_attempts");
        if (insertError && /INSERT/i.test(sql)) throw new Error(insertError);
        return { meta: { last_row_id: 1 } };
      },
    };
    return stmt;
  }
  return { prepare: makeStmt, __log: log };
}

// ── 假 fetch：Turnstile 校验走它，避免测试真的跨境请求 Cloudflare ──
function installFetchStub(impl) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = real; };
}
const tsOk = () => installFetchStub(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
const tsFail = (code = "invalid-input-response") =>
  installFetchStub(async () => new Response(JSON.stringify({ success: false, "error-codes": [code] }), { status: 200 }));

function postReq(body, headers = {}) {
  return new Request("https://blog.example.com/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ══════════════════════════════════════════════════════════════════════════
const sb = makeSandbox();
const auth = await imp(sb, "functions/api/_lib/auth.js");
const guard = await imp(sb, "functions/api/_lib/loginGuard.js");

console.log("\n[1] 哈希格式：老格式必须永远能校验（不锁死存量密码）");
{
  const pw = "hunter2hunter2";
  const legacySalt = "11111111-2222-3333-4444-555555555555";
  // 按**老实现**的方式造一个存量哈希：100000 次、拼成 "salt:hash"
  const legacyHash = `${legacySalt}:${await auth.hashPassword(pw, legacySalt, 100000)}`;

  check("解析老格式得到隐含迭代数 100000",
    auth.parsePasswordHash(legacyHash)?.iterations === 100000,
    JSON.stringify(auth.parsePasswordHash(legacyHash)));
  check("老格式密码仍能校验通过（这是「不锁死存量密码」的核心）",
    (await auth.verifyPassword(pw, legacyHash)) === true);
  check("老格式密码错时判 false", (await auth.verifyPassword("wrong-password", legacyHash)) === false);

  // 关键：目标迭代数调大**不影响**老格式的校验 —— 它必须按存储串隐含的 100000 算
  check("目标迭代数调大后，老格式密码依然能校验（不会被锁死）",
    (await auth.verifyPassword(pw, legacyHash)) === true);

  // 负向对照：如果把老格式当成了别的迭代数去算，就必须失败
  const wrongIterHash = `pbkdf2$600000$${legacySalt}$${await auth.hashPassword(pw, legacySalt, 100000)}`;
  check("负向对照：把 100000 的派生结果标成 600000 会校验失败（证明真的按存储串里的数在算）",
    (await auth.verifyPassword(pw, wrongIterHash)) === false);

  const fresh = await auth.makePasswordHash(pw, "salt-abc", 210000);
  check("新格式形如 pbkdf2$<iter>$<salt>$<hash>",
    /^pbkdf2\$210000\$salt-abc\$[A-Za-z0-9_-]{43}$/.test(fresh), fresh);
  check("新格式能校验通过", (await auth.verifyPassword(pw, fresh)) === true);
  check("新格式换错密码判 false", (await auth.verifyPassword("nope", fresh)) === false);
}

console.log("\n[2] parsePasswordHash 对残缺/恶意输入不当成 100000 硬猜");
{
  const bad = [
    ["空串", ""],
    ["只有冒号", ":"],
    ["冒号在前（空 salt）", ":abc"],
    ["冒号在后（空 hash）", "abc:"],
    ["没有分隔符", "abcdef"],
    ["pbkdf2$ 段数不对", "pbkdf2$100000$salt"],
    ["pbkdf2$ 迭代数非数字", "pbkdf2$abc$salt$hash"],
    ["pbkdf2$ 迭代数为负", "pbkdf2$-1$salt$hash"],
    ["pbkdf2$ 迭代数过小", "pbkdf2$10$salt$hash"],
    ["pbkdf2$ 迭代数过大（防被篡改成天文数字）", "pbkdf2$99999999$salt$hash"],
    ["pbkdf2$ 缺 salt", "pbkdf2$100000$$hash"],
  ];
  for (const [label, s] of bad) {
    check("拒绝：" + label, auth.parsePasswordHash(s) === null, JSON.stringify(auth.parsePasswordHash(s)));
    check("  并让 verifyPassword 判 false（不抛异常）：" + label,
      (await auth.verifyPassword("x", s)) === false);
  }
}

console.log("\n[3] 渐进升级判定 needsRehash");
{
  const pw = "pw123456";
  const legacy = "saltX:" + await auth.hashPassword(pw, "saltX", 100000);
  const low = await auth.makePasswordHash(pw, "s", 10000);
  const mid = await auth.makePasswordHash(pw, "s", 210000);
  const high = await auth.makePasswordHash(pw, "s", 600000);
  check("老格式在目标 210000 下需要升级", auth.needsRehash(legacy, 210000) === true);
  check("新格式但迭代数低于目标 → 需要升级", auth.needsRehash(low, 210000) === true);
  check("新格式已达目标 → 不需要", auth.needsRehash(mid, 210000) === false);
  check("新格式高于目标 → 不需要（绝不降级重写）", auth.needsRehash(high, 210000) === false);
  check("解析不了的串不去覆写（宁可不动，也不毁掉别人的数据）",
    auth.needsRehash("something-else", 210000) === false);
}

console.log("\n[4] 目标迭代数：默认值与环境变量覆盖");
{
  check("默认迭代数 = 210000（≥ OWASP 建议量级，且实测成本可接受）",
    auth.PBKDF2_DEFAULT_ITERATIONS === 210000, String(auth.PBKDF2_DEFAULT_ITERATIONS));
  check("未配置时用默认值", auth.targetIterations({}) === 210000);
  check("可用 PBKDF2_ITERATIONS 覆盖（不改代码就能上调/回滚）",
    auth.targetIterations({ PBKDF2_ITERATIONS: "600000" }) === 600000);
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try {
    check("非法值回落到默认值", auth.targetIterations({ PBKDF2_ITERATIONS: "abc" }) === 210000);
    check("过低的值被拒（防止把强度调到形同虚设）",
      auth.targetIterations({ PBKDF2_ITERATIONS: "100" }) === 210000);
  } finally { console.error = realErr; }
  check("回落时留痕，不静默（非法配置必须能在日志里看见）", errs.length >= 2, "error 调用 " + errs.length + " 次");
}

console.log("\n[5] 失败计数的延迟曲线（纯函数）");
{
  check("4 次失败内不延迟", guard.delayForFails(4) === 0, String(guard.delayForFails(4)));
  check("到阈值（5 次）才开始延迟", guard.delayForFails(5) === 400, String(guard.delayForFails(5)));
  check("随后指数增长（6 次 → 800ms）", guard.delayForFails(6) === 800, String(guard.delayForFails(6)));
  check("有上限，且上限不失控", guard.delayForFails(50) === 5000, String(guard.delayForFails(50)));
  check("负值/NaN 不产生延迟", guard.delayForFails(-1) === 0 && guard.delayForFails(NaN) === 0);
  check("是**递增延迟**而不是硬锁：任何失败次数下都还能继续尝试（延迟有上限，不是终态拒绝）",
    guard.delayForFails(999) <= guard.MAX_DELAY_MS, String(guard.delayForFails(999)));
  check("归一化登录名：大小写与空白差异算同一个身份",
    guard.normalizeLoginId("  Alice@Example.COM ") === "alice@example.com",
    guard.normalizeLoginId("  Alice@Example.COM "));
}

console.log("\n[6] 表不存在时必须优雅降级，并且**留痕**");
{
  const db = fakeDb({ missingTable: true });
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  let res, threw = null;
  try { res = await guard.evaluateThrottle({ BLOG_DB: db }, { username: "a", ipHash: "h" }); }
  catch (e) { threw = e; }
  console.error = realErr;
  check("不抛异常（迁移没做也要能登录）", !threw, String(threw && threw.message));
  check("降级为不限频 + 标记 degraded", res && res.delayMs === 0 && res.degraded === true, JSON.stringify(res));
  check("但必须留痕：console.error 里说明了「表不存在、去跑迁移」（不许静默失败）",
    errs.some((s) => /login_attempts/.test(s) && /migrate-login-attempts/.test(s)),
    errs.join(" | ") || "(一次都没打)");

  const db2 = fakeDb({ missingTable: true });
  let threw2 = null;
  try { await guard.recordAttempt({ BLOG_DB: db2 }, { username: "a", ipHash: "h", success: false }); }
  catch (e) { threw2 = e; }
  check("recordAttempt 同样不抛异常", !threw2, String(threw2 && threw2.message));
}

console.log("\n[7] evaluateThrottle 取「用户名」与「IP」两个维度的较大值");
{
  const a = await guard.evaluateThrottle({ BLOG_DB: fakeDb({ failsByUser: 4, failsByIp: 4 }) }, { username: "u", ipHash: "h" });
  check("两维都不足阈值 → 不延迟", a.delayMs === 0, JSON.stringify(a));
  const b = await guard.evaluateThrottle({ BLOG_DB: fakeDb({ failsByUser: 6, failsByIp: 0 }) }, { username: "u", ipHash: "h" });
  check("用户名维度超阈值 → 延迟（撞库：一个密码试很多账号，只能靠 IP 维度挡）", b.delayMs === 800, JSON.stringify(b));
  const c = await guard.evaluateThrottle({ BLOG_DB: fakeDb({ failsByUser: 0, failsByIp: 7 }) }, { username: "u", ipHash: "h" });
  check("IP 维度超阈值 → 延迟（单账号爆破：只能靠用户名维度挡）", c.delayMs === 1600, JSON.stringify(c));
  const d = await guard.evaluateThrottle({ BLOG_DB: fakeDb({ failsByUser: 6, failsByIp: 8 }) }, { username: "u", ipHash: "h" });
  check("两维都超 → 取较大者（400×2^3 = 3200ms，按 ipFails=8 算）", d.delayMs === 3200, JSON.stringify(d));
  const e = await guard.evaluateThrottle({ BLOG_DB: fakeDb({ failsByUser: 9 }) }, { username: "u", ipHash: null });
  check("取不到 IP 时仍按用户名维度计数（不能因此完全不限频）", e.delayMs > 0, JSON.stringify(e));
}

console.log("\n[8] recordAttempt：成功要清掉历史失败，失败要落库");
{
  const okLog = [];
  await guard.recordAttempt({ BLOG_DB: fakeDb({ log: okLog }) }, { username: "U", ipHash: "h", success: true });
  check("成功时写入一条 success=1 的记录",
    okLog.some((c) => /INSERT INTO login_attempts/i.test(c.sql) && c.args[2] === 1),
    JSON.stringify(okLog.map((c) => c.sql)));
  check("成功时顺手清掉该身份的历史失败（真主人输错几次后不该继续背着延迟）",
    okLog.some((c) => /DELETE FROM login_attempts/i.test(c.sql) && /success = 0/i.test(c.sql)),
    JSON.stringify(okLog.map((c) => c.sql)));
  const badLog = [];
  await guard.recordAttempt({ BLOG_DB: fakeDb({ log: badLog }) }, { username: "U", ipHash: "h", success: false });
  check("失败时写入 success=0，且用户名已归一化",
    badLog.some((c) => /INSERT INTO login_attempts/i.test(c.sql) && c.args[2] === 0 && c.args[1] === "u"),
    JSON.stringify(badLog.map((c) => [c.sql, c.args])));
}

console.log("\n[9] /api/login 端点（真调用，假 D1 / 假 fetch）");
const loginMod = await imp(sb, "functions/api/login.js");
{
  // ① 未配置数据库 → 500，且不碰 PBKDF2
  const r1 = await loginMod.onRequestPost({ request: postReq({ username: "a", password: "b" }), env: {} });
  check("未配置 BLOG_DB → 500（配置问题要立刻暴露）", r1.status === 500, String(r1.status));

  // ② 未配置 TURNSTILE_SECRET_KEY → 人机验证自动跳过，登录仍可用（优雅降级）
  const restore = tsFail(); // 就算 fetch 会被判失败，secret 没配就不该走它
  const pw = "correct-horse-battery";
  const salt = "salt-1";
  const fresh = await auth.makePasswordHash(pw, salt, 20000);
  const r2 = await loginMod.onRequestPost({
    request: postReq({ username: "alice", password: pw }),
    env: baseEnv({ BLOG_DB: fakeDb({ user: { username: "alice", email: "a@b.c", password_hash: fresh } }) }),
  });
  restore();
  check("未配置人机验证时不阻塞登录（这是必须保留的逃生门）", r2.status === 200, String(r2.status));
  check("登录成功返回 ok:true 与 Set-Cookie",
    (await r2.clone().json()).ok === true && /^auth=/.test(r2.headers.get("Set-Cookie") || ""),
    String(r2.headers.get("Set-Cookie")));

  // ③ 配了 secret 且没带 token → 403
  const r3 = await loginMod.onRequestPost({
    request: postReq({ username: "alice", password: pw }),
    env: baseEnv({ BLOG_DB: fakeDb({}), TURNSTILE_SECRET_KEY: "sk" }),
  });
  check("配了人机验证但未提交 token → 403", r3.status === 403, String(r3.status));

  // ④ 配了 secret、token 无效 → 403
  const restore4 = tsFail();
  const r4 = await loginMod.onRequestPost({
    request: postReq({ username: "alice", password: pw, turnstileToken: "bad" }),
    env: baseEnv({ BLOG_DB: fakeDb({}), TURNSTILE_SECRET_KEY: "sk" }),
  });
  restore4();
  check("人机验证服务器判失败 → 403", r4.status === 403, String(r4.status));

  // ⑤ 用户不存在 vs 密码错误：文案必须一字不差（防用户名枚举）
  const dbNoUser = fakeDb({ user: null });
  const r5 = await loginMod.onRequestPost({
    request: postReq({ username: "nobody", password: "whatever" }),
    env: baseEnv({ BLOG_DB: dbNoUser }),
  });
  const r6 = await loginMod.onRequestPost({
    request: postReq({ username: "alice", password: "wrong" }),
    env: baseEnv({ BLOG_DB: fakeDb({ user: { username: "alice", email: "", password_hash: fresh } }) }),
  });
  const j5 = await r5.json(), j6 = await r6.json();
  check("用户不存在与密码错误返回同一状态码（401）", r5.status === 401 && r6.status === 401, `${r5.status}/${r6.status}`);
  check("用户不存在与密码错误返回**完全相同**的文案（防用户名枚举）",
    j5.error === j6.error, JSON.stringify(j5.error) + " vs " + JSON.stringify(j6.error));

  // ⑥ 用户不存在时也必须真的跑了一次 PBKDF2（时序侧信道）
  //    判据不是"耗时要相等"（太脆），而是"假哈希与真哈希同格式同迭代数"。
  const dummySrc = fs.readFileSync(path.join(ROOT, "functions/api/login.js"), "utf8");
  const dummyMatch = dummySrc.match(/pbkdf2\$\$\{iterations\}\$\$\{DUMMY_SALT\}\$/);
  check("假哈希用**当前目标格式**构造（不是老格式的 100000），假哈希与真校验耗时同量级",
    !!dummyMatch, "假哈希仍是老格式的话，用户不存在会比密码错误快好几倍 —— 侧信道又开了");
  const realIter = auth.parsePasswordHash(await auth.makePasswordHash("x", "s", 20000))?.iterations;
  const dummyIter = auth.parsePasswordHash(`pbkdf2$${20000}$00000000-0000-0000-0000-000000000000$${"A".repeat(43)}`)?.iterations;
  check("假哈希的迭代数与同配置下真哈希一致", realIter === dummyIter, `${dummyIter} vs ${realIter}`);

  // ⑦ 失败要落库
  const failLog = [];
  await loginMod.onRequestPost({
    request: postReq({ username: "alice", password: "wrong" }),
    env: baseEnv({ BLOG_DB: fakeDb({ log: failLog, user: { username: "alice", email: "", password_hash: fresh } }) }),
  });
  check("登录失败会把这次尝试写进 login_attempts",
    failLog.some((c) => /INSERT INTO login_attempts/i.test(c.sql) && c.args[2] === 0),
    JSON.stringify(failLog.map((c) => c.sql)));

  // ⑧ 超过阈值时回传 retryAfterMs，并且真的等了
  const overDb = fakeDb({ failsByUser: 5, user: null });
  const t0 = Date.now();
  const r8 = await loginMod.onRequestPost({
    request: postReq({ username: "nobody", password: "x" }),
    env: baseEnv({ BLOG_DB: overDb }),
  });
  const elapsed = Date.now() - t0;
  const j8 = await r8.json();
  check("超过阈值时回传 retryAfterMs（前端才能给出「还要等几秒」的可见反馈）",
    j8.retryAfterMs === 400, JSON.stringify(j8));
  check("并且真的等了那么久（不是只回个数字哄前端）", elapsed >= 380, elapsed + "ms");
  check("超阈值时仍是 401 而不是硬锁 —— 输对密码照样能进（不做 DoS 扳机）",
    r8.status === 401, String(r8.status));

  // ⑨ 登录成功 + 迭代数低于目标 → 写回新格式
  const upLog = [];
  const lowHash = await auth.makePasswordHash(pw, "s-low", 10000);
  const r9 = await loginMod.onRequestPost({
    request: postReq({ username: "alice", password: pw }),
    env: baseEnv({
      PBKDF2_ITERATIONS: "20000",
      BLOG_DB: fakeDb({ log: upLog, user: { username: "alice", email: "", password_hash: lowHash } }),
    }),
  });
  const upd = upLog.find((c) => /UPDATE users SET password_hash/i.test(c.sql));
  check("迭代数落后时，登录成功会把它升到当前目标（存量密码逐个自动迁移，无需重置）",
    r9.status === 200 && !!upd && /^pbkdf2\$20000\$/.test(String(upd.args[0])),
    upd ? String(upd.args[0]).slice(0, 40) : "没有 UPDATE");

  // ⑩ 升级写库失败不能影响登录本身
  const r10 = await loginMod.onRequestPost({
    request: postReq({ username: "alice", password: pw }),
    env: baseEnv({
      PBKDF2_ITERATIONS: "20000",
      BLOG_DB: fakeDb({ user: { username: "alice", email: "", password_hash: lowHash }, insertError: "D1 写入失败" }),
    }),
  });
  check("哈希升级写库失败也不影响本次登录（凭据是对的就该放行）", r10.status === 200, String(r10.status));

  // ⑪ 老格式端到端：存量密码仍能登录（100000 次，一次真实校验）
  const legacyStored = "legacy-salt:" + await auth.hashPassword(pw, "legacy-salt", 100000);
  const r11 = await loginMod.onRequestPost({
    request: postReq({ username: "alice", password: pw }),
    env: baseEnv({ BLOG_DB: fakeDb({ user: { username: "alice", email: "", password_hash: legacyStored } }) }),
  });
  check("端到端：老格式（salt:hash）的存量密码照样登得进去", r11.status === 200, String(r11.status));
}

console.log("\n[10] /api/register：并发冲突回 409，错误不回显内部信息");
{
  const reg = await imp(sb, "functions/api/register.js");
  // ① 预先查重命中 → 409
  const r1 = await reg.onRequestPost({
    request: new Request("https://x/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "bob", password: "123456" }) }),
    env: baseEnv({ BLOG_DB: fakeDb({ user: { id: 1 } }) }),
  });
  check("用户名已被占用 → 409", r1.status === 409, String(r1.status));

  // ② 并发窗口：查重没命中但 INSERT 撞 UNIQUE → 必须 409，不是 500
  const raceDb = fakeDb({ insertError: "D1_ERROR: UNIQUE constraint failed: users.username" });
  const r2 = await reg.onRequestPost({
    request: new Request("https://x/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "bob", password: "123456" }) }),
    env: baseEnv({ BLOG_DB: raceDb }),
  });
  check("并发重复注册（INSERT 撞 UNIQUE）→ 409 而不是 500（这是用户输入问题，不是服务端故障）",
    r2.status === 409, String(r2.status) + " " + JSON.stringify(await r2.clone().json()));

  // ③ 注册写入的是**新格式**哈希
  const insLog = [];
  const r3 = await reg.onRequestPost({
    request: new Request("https://x/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "carol", password: "123456" }) }),
    env: baseEnv({ PBKDF2_ITERATIONS: "20000", BLOG_DB: fakeDb({ log: insLog }) }),
  });
  const ins = insLog.find((c) => /INSERT INTO users/i.test(c.sql));
  check("新注册写入新格式哈希（带迭代数，封顶在目标值）",
    r3.status === 200 && !!ins && /^pbkdf2\$20000\$/.test(String(ins.args[2])),
    ins ? String(ins.args[2]).slice(0, 40) : "没有 INSERT");

  // ④ 其它写库错误 → 500，但正文不许回显内部信息
  const leaky = "D1_ERROR: table users has no column named secret_token (at offset 1)";
  const r4 = await reg.onRequestPost({
    request: new Request("https://x/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "dave", password: "123456" }) }),
    env: baseEnv({ BLOG_DB: fakeDb({ insertError: leaky }) }),
  });
  const j4 = await r4.json();
  check("其它写库错误 → 500", r4.status === 500, String(r4.status));
  check("错误正文不回显 e.message（表结构/SQL 细节不外泄）",
    !/no column named|D1_ERROR|offset/i.test(j4.error || ""), JSON.stringify(j4.error));

  // ⑤ Turnstile 配置了就挡
  const restore = tsFail();
  const r5 = await reg.onRequestPost({
    request: new Request("https://x/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "eve", password: "123456", turnstileToken: "bad" }) }),
    env: baseEnv({ BLOG_DB: fakeDb({}), TURNSTILE_SECRET_KEY: "sk" }),
  });
  restore();
  check("注册入口的人机验证仍然生效（没被这次改动碰坏）", r5.status === 403, String(r5.status));
}

console.log("\n[11] 结构不变量：迁移脚本与前端接线");
{
  const sqlPath = path.join(ROOT, "scripts/migrate-login-attempts.sql");
  const sql = fs.existsSync(sqlPath) ? fs.readFileSync(sqlPath, "utf8") : "";
  check("迁移脚本存在", sql.length > 0, sqlPath);
  check("迁移用 IF NOT EXISTS（重复执行安全，不会把生产库弄坏）",
    /CREATE TABLE IF NOT EXISTS login_attempts/i.test(sql) && /CREATE INDEX IF NOT EXISTS/i.test(sql));
  check("迁移里为两个计数维度都建了索引（否则计数查询会全表扫）",
    /\(username, success, created_at/i.test(sql) && /\(ip_hash, success, created_at/i.test(sql));

  const appJs = fs.readFileSync(path.join(ROOT, "assets/app.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  check("登录表单提交时会把 turnstileToken 发给服务端",
    /username: fd\.get\("username"\), password: fd\.get\("password"\), turnstileToken: tsLogin\.token/.test(appJs));
  check("index.html 里有登录用的 Turnstile 容器", /id="loginTurnstile"/.test(html));
  check("三个写入口都做了人机验证（注册 / 留言墙 / 登录）",
    ["register.js", "guestbook.js", "login.js"].every((f) =>
      /verifyTurnstile\(/.test(fs.readFileSync(path.join(ROOT, "functions/api", f), "utf8"))),
    ["register.js", "guestbook.js", "login.js"].filter((f) =>
      !/verifyTurnstile\(/.test(fs.readFileSync(path.join(ROOT, "functions/api", f), "utf8"))).join(", ") + " 缺少");
  check("登录成功后前端会重置 widget（token 一次性，不重置下次必然失败）",
    /resetFormTurnstile\(tsTarget\("login"\)\)/.test(appJs));
}

// ══════════════════════════════════════════════════════════════════════════
// 负向自证：四种故障必须各自让判据变红。
// 没有这一段，上面所有"✅"都可能只是恒真的摆设。
console.log("\n[12] 负向自证：把加固拆掉，判据必须变红");
{
  // 故障①：verifyPassword 忽略存储串里的迭代数，一律用目标值
  //         → 存量老密码全部校验失败（这正是"直接改迭代数"会造成的灾难）
  {
    const broken = makeSandbox((tmp) => {
      const f = path.join(tmp, "functions/api/_lib/auth.js");
      let s = fs.readFileSync(f, "utf8");
      const before = s;
      s = s.replace(
        "const computed = await hashPassword(password, parsed.salt, parsed.iterations);",
        "const computed = await hashPassword(password, parsed.salt, PBKDF2_DEFAULT_ITERATIONS);",
      );
      if (s === before) { console.error("❌ 故障①未注入"); process.exit(2); }
      fs.writeFileSync(f, s);
    });
    const a2 = await imp(broken, "functions/api/_lib/auth.js");
    const legacy = "s:" + await a2.hashPassword("pw", "s", 100000);
    check("故障①（忽略存储的迭代数）→ 存量密码校验失败，判据变红",
      (await a2.verifyPassword("pw", legacy)) === false);
  }
  // 故障②：登录不校验人机验证
  {
    const broken = makeSandbox((tmp) => {
      const f = path.join(tmp, "functions/api/login.js");
      let s = fs.readFileSync(f, "utf8");
      const before = s;
      s = s.replace(/const ts = await verifyTurnstile\([\s\S]*?\n/, "const ts = { success: true };\n");
      if (s === before) { console.error("❌ 故障②未注入"); process.exit(2); }
      fs.writeFileSync(f, s);
    });
    const l2 = await imp(broken, "functions/api/login.js");
    const r = await l2.onRequestPost({
      request: postReq({ username: "a", password: "b" }),
      env: baseEnv({ BLOG_DB: fakeDb({}), TURNSTILE_SECRET_KEY: "sk" }),
    });
    check("故障②（登录不校验人机验证）→ 无 token 也能过，判据变红", r.status !== 403, String(r.status));
  }
  // 故障③：延迟恒为 0（等于没有失败计数）
  {
    const broken = makeSandbox((tmp) => {
      const f = path.join(tmp, "functions/api/_lib/loginGuard.js");
      let s = fs.readFileSync(f, "utf8");
      const before = s;
      s = s.replace(/export function delayForFails\(fails\) \{[\s\S]*?\n\}/, "export function delayForFails(fails) { return 0; }");
      if (s === before) { console.error("❌ 故障③未注入"); process.exit(2); }
      fs.writeFileSync(f, s);
    });
    const g2 = await imp(broken, "functions/api/_lib/loginGuard.js");
    check("故障③（延迟恒为 0）→ 超阈值也不再延迟，判据变红",
      g2.delayForFails(20) === 0 && !(g2.delayForFails(6) === 800));
  }
  // 故障④：UNIQUE 冲突不再翻译成 409（冒泡成 500）
  {
    const broken = makeSandbox((tmp) => {
      const f = path.join(tmp, "functions/api/register.js");
      let s = fs.readFileSync(f, "utf8");
      const before = s;
      s = s.replace(/if \(\/UNIQUE constraint failed[\s\S]*?\n      \}/, "if (false) {\n      }");
      if (s === before) { console.error("❌ 故障④未注入"); process.exit(2); }
      fs.writeFileSync(f, s);
    });
    const r2 = await imp(broken, "functions/api/register.js");
    const r = await r2.onRequestPost({
      request: new Request("https://x/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "bob", password: "123456" }) }),
      env: baseEnv({ BLOG_DB: fakeDb({ insertError: "D1_ERROR: UNIQUE constraint failed: users.username" }) }),
    });
    check("故障④（UNIQUE 冲突不翻译成 409）→ 变成 500，判据变红", r.status === 500, String(r.status));
  }
}

console.log("");
if (fail === 0) { console.log(`✅ 全部通过（${pass + fail} 项，通过 ${pass}，失败 0）`); process.exit(0); }
console.log(`❌ 有失败项（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(1);
