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
    // ⚠️ performance.now() 在 Workers 里不可用于计时（实测恒 0 —— 见 perfRaw，平台的
    //    计时器精度被故意做粗以防旁路）。所以这里**不用它下结论**，只回传原始值自证「它确实不可用」。
    const t0 = performance.now();
    // ⚠️ 捕获异常并回传 e.name —— 这是区分「平台终止请求」与「JS 抛错」的唯一办法：
    //    平台终止 ⇒ 我们拿不到任何响应体（只有 Cloudflare 错误页）；
    //    JS 抛错   ⇒ 能捕获到 e.name（如 NotSupportedError）。
    let errName = null, errMsg = null;
    try {
      await makePasswordHash("diag-probe-pw", crypto.randomUUID(), n);
    } catch (e) {
      errName = (e && e.name) || "(无 name)";
      errMsg = String((e && e.message) || e);
    }
    return json(
      { ok: !errName, n, perfMs: +(performance.now() - t0).toFixed(2), perfRaw: [t0, performance.now()], errName, errMsg },
      200,
      { "Cache-Control": "no-store" }
    );
  }

  return json(
    { ok: true, turnstileSiteKey: env.TURNSTILE_SITE_KEY || null },
    200,
    { "Cache-Control": "public, max-age=300, s-maxage=300" }
  );
}
