// GET /api/config —— 下发前端需要的公开配置（不含任何密钥）
// 目前只有 Turnstile 的 Site Key（Site Key 本身是公开的，可安全暴露给浏览器）
import { json } from "./_lib/auth.js";

export async function onRequestGet({ env }) {
  return json(
    { ok: true, turnstileSiteKey: env.TURNSTILE_SITE_KEY || null },
    200,
    { "Cache-Control": "public, max-age=300, s-maxage=300" }
  );
}
