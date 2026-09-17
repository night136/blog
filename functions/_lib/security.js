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

  // ══ CSP ══
  //
  // 上半（object-src / base-uri / frame-ancestors）是「不需要 nonce 的那一半」，先落地；
  // 下半（script-src / style-src）2026-09-17 补齐，两条路数**故意不同**：
  //
  // ① script-src 走 **sha256 白名单**（严格）：
  //      内联启动脚本只有 1 段（index.html 里那段标记 __APP_BOOTED__ / 兜底横幅的），
  //      它是**源码里的静态文本**，构建期不碰它（build.mjs 只改资源 URL + 内联 style.css），
  //      所以它的哈希是稳定常量，不会"这次部署对、下次部署白屏"。
  //      'self' 覆盖 assets/app.js 与两个按需注入的 vendor 脚本（qrcode / highlight），
  //      challenges.cloudflare.com 是 Turnstile 的 api.js（app.js 在切到留言墙/注册时才注入）。
  //      ⚠️ 刻意**没有** 'unsafe-inline'：内联事件处理器（onclick=…）不算在内，
  //        所以 index.html 里兜底横幅那两个按钮已从 onclick 改成 addEventListener（同一段内联脚本里绑）。
  //      ⚠️ 哈希是按 **LF** 算的。仓库 core.autocrlf=true，提交后线上收到的是 LF；
  //        拿工作区的 CRLF 原文去算会得到**另一个值**（实测差 115 个字符），线上直接白屏。
  //        看门狗 scripts/verify-security-headers.mjs 会按 LF 重算并逐字比对，改脚本就判红。
  //
  // ② style-src 只能是**来源白名单 + 'unsafe-inline'**（宽），因为哈希在这里真的做不到：
  //      · index.html 里有 19 处 style="…" 内联属性，运行期还有大量 el.style.x = … ；
  //        style-src 一旦去掉 'unsafe-inline'，这些全部失效（要放行得给每个属性值算 'unsafe-hashes'，
  //        而属性值是动态拼的，根本枚举不完）；
  //      · 构建期还会把整张 assets/style.css 内联成 <style data-inlined="style.css">，
  //        它的内容**随每次改样式而变** ⇒ 哈希是构建产物、不是源码常量，写死在头里必然过期。
  //      所以这一条的价值是**收窄来源**（挡住 data:/http:/任意外域样式表注入、@import 外链），
  //      而不是挡住内联样式。别把 'unsafe-inline' 删掉——那是白屏，不是加固。
  "Content-Security-Policy":
    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; " +
    "script-src 'self' 'sha256-CJjlP287d9o8os05q1pTscyxju+Buc5X14AenQ46bUY=' https://challenges.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.font.im",
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
