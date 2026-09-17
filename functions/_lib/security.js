// 安全响应头的**唯一来源**（Functions 侧）。
//
// ⚠️ 为什么非要有这个文件：Cloudflare Pages 的 `_headers` **只对静态资源生效**，
//    Functions 自己 `new Response(...)` 出来的响应根本不经过它。
//    2026-09-17 线上逐端点实测（audit §八）：
//        /assets/style.css  → nosniff ✓ referrer-policy ✓
//        /sitemap.xml       → 一个安全头都没有
//        /api/*             → 一个安全头都没有
//    也就是说，**全站唯一真正需要防护的入口（写接口、登录口）反而全裸**。
//    修法就是这一层：`functions/_middleware.js` 给所有函数响应兜一层。
//
// ⚠️ 这里的值与 `_headers` 里那份是**两份拷贝**（`_headers` 是纯文本，没法 import）。
//    谁也不会替你同步 —— `scripts/verify-security-headers.mjs` 会逐个头比对，
//    只改一边就判红。这是刻意的：宁可让守护吵，也不要线上悄悄少一个头。

export const SECURITY_HEADERS = {
  // 声明了 Content-Type 就别让浏览器再去猜（JSON 被当 HTML 解析 = XSS 的经典入口）
  "X-Content-Type-Options": "nosniff",

  // 跨站时不外泄完整 URL（含 ?post=<slug> 这类路径）。与 _headers 里那份同值。
  "Referrer-Policy": "strict-origin-when-cross-origin",

  // ⚠️ 刻意**不带** includeSubDomains：pages.dev 是所有 Cloudflare Pages 项目共用的域，
  //    加 includeSubDomains 等于替别人的项目做决定。
  //    也刻意**不带** preload：那要提交进浏览器预加载列表，撤不回来。
  //    只对 blog-6p3.pages.dev 这一个主机生效，就是这个头该有的范围。
  "Strict-Transport-Security": "max-age=31536000",

  // 本站不需要被任何地方嵌入（全仓 0 个 <iframe>），所以直接 deny。
  "X-Frame-Options": "DENY",

  // ⚠️ 刻意**不列** clipboard-write / clipboard-read / web-share：
  //    「复制链接」用 navigator.clipboard、「分享」用 navigator.share（assets/app.js:682/824），
  //    把这几项写进 () 等于亲手把这两个按钮弄坏。
  //    没列出来的能力走默认 allowlist，不受影响。
  "Permissions-Policy":
    "geolocation=(), camera=(), microphone=(), payment=(), usb=(), " +
    "magnetometer=(), gyroscope=(), accelerometer=(), midi=(), serial=(), hid=()",

  // CSP 只上**不需要 nonce 的那一半**：
  //   object-src 'none'       —— 全仓 0 个 <object>/<embed>（插件加载面直接封死）
  //   base-uri 'self'         —— 全仓 0 个 <base>（防「注入一个 <base> 劫持所有相对 URL」）
  //   frame-ancestors 'none'  —— 与 X-Frame-Options: DENY 等价（给不支持 XFO 的浏览器兜底）
  // ⚠️ script-src / style-src **故意没写**：页面里内联了 3 段 <script> + 关键 CSS <style>，
  //    构建期还会内联整张 style.css，app.js 也在运行时注入样式。
  //    直接上 `script-src 'self'` 会把它们全挡掉 —— 那需要 nonce 或 hash，是独立一项（见 audit §八）。
  //    注意：CSP 是「多个头取交集」，这里只收窄了三条，不会与将来的 script-src 冲突。
  "Content-Security-Policy": "object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
};

// 给一个已经成型的响应补上安全头。
//
// ⚠️ 为什么必须换一个 Response 对象：来自 fetch / 静态资源 / next() 的响应，
//    它的 headers 是**不可变**的（immutable），直接 set 会抛 TypeError。
//
// ⚠️ 为什么必须用 res 自身当 init 逐项带过 status/statusText/headers：
//    `new Headers(res.headers)` 会**保留 set-cookie 的多个值**（登录/登出就靠它）。
//    这里绝不能"只抄几个我关心的头" —— 那会顺手丢掉 cache-control 之类的东西。
//
// 本函数**只加不删**：只 set 上面那 6 个安全头，不碰 Content-Type / Cache-Control / Set-Cookie。
export function withSecurityHeaders(res) {
  const out = new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
  return out;
}
