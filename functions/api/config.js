// GET /api/config —— 下发前端需要的公开配置（不含任何密钥）
// 目前只有 Turnstile 的 Site Key（Site Key 本身是公开的，可安全暴露给浏览器）
import { json, makePasswordHash } from "./_lib/auth.js";

// ⚠️⚠️ 临时诊断分支（2026-09-17，**测完立即删除**）：
// 目的：回答「100000 次 PBKDF2 在 10ms 的边缘 CPU 预算下到底够不够、余量多少」。
// 之前只有**间接推理**（210000 挂 / 100000 通 + 官方 10ms），没有边缘上的直接数字；
// 而本机 Node 测的 30ms 是**墙钟**，不能直接与边缘的 **CPU 时间**预算相比。
// 用法：GET /api/config?__hashdiag=<iterations>  ⇒ { ok, n, ms }
//   · 只读：不写任何数据，只做一次哈希计算；
//   · 单次只算一个 n（防止被拿来批量放大 CPU）；
//   · 限幅 10000–400000，避免超大值直接把请求打爆；
//   · no-store，绝不进边缘缓存。
const DIAG_MIN = 10000;
const DIAG_MAX = 400000;

export async function onRequestGet({ request, env }) {
  const raw = new URL(request.url).searchParams.get("__hashdiag");
  if (raw !== null) {
    const n = parseInt(raw, 10) || 100000;
    if (!(n >= DIAG_MIN && n <= DIAG_MAX)) {
      return json({ error: `n 需在 ${DIAG_MIN}–${DIAG_MAX} 之间` }, 400, { "Cache-Control": "no-store" });
    }
    // ⚠️ performance.now() 在 Workers 里是**墙钟**，而限额算 **CPU 时间**。
    //    但 PBKDF2 是纯计算、中途不 await 任何 I/O ⇒ 这段墙钟 ≈ CPU 时间，是可用近似。
    const t0 = performance.now();
    await makePasswordHash("diag-probe-pw", crypto.randomUUID(), n);
    const ms = +(performance.now() - t0).toFixed(2);
    return json({ ok: true, n, ms }, 200, { "Cache-Control": "no-store" });
  }

  return json(
    { ok: true, turnstileSiteKey: env.TURNSTILE_SITE_KEY || null },
    200,
    { "Cache-Control": "public, max-age=300, s-maxage=300" }
  );
}
