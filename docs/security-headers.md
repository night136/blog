# 安全响应头：两条投递路径，两份拷贝，一个守护

> 2026-09-17。对应 `docs/optimization-audit-2026-09-16.md` §八。
> 离线守护：`scripts/verify-security-headers.mjs`（74 项，含 4 项负向自证）
> 线上验收：`node scripts/audit-live.mjs`（有 PASS/FAIL 与退出码）

## 一句话

Cloudflare Pages 的 `_headers` **只对静态资源生效**。Functions 自己 `new Response(...)`
出来的响应完全不经过它 —— 所以全站**唯一真正需要防护的入口**（`/api/login`、`/api/register`、
`/api/guestbook` 的写接口…）在 2026-09-17 之前**一个安全头都没有**，而 `/assets/*.png` 反而有。

## 线上实测（改动前 → 改动后）

| 响应头 | 静态资源 | 函数响应（改动前） | 函数响应（改动后） |
|---|---|---|---|
| `x-content-type-options` | ✅ | ❌ | ✅ |
| `referrer-policy` | ✅ | ❌ | ✅ |
| `strict-transport-security` | ❌ | ❌ | ✅ |
| `x-frame-options` | ❌ | ❌ | ✅ |
| `permissions-policy` | ❌ | ❌ | ✅ |
| `content-security-policy` | ❌ | ❌ | ✅（只上了不需要 nonce 的那一半） |

`/sitemap.xml` 改动前的完整响应头里，除了 `Content-Type` / `Content-Length` / `Date`
就只有 Cloudflare 自己的 `Report-To` / `Nel` / `server` —— 一个防护头都没有。

## 修法：两条路径各管一半，缺一不可

```
静态资源（/assets/*、/404.html、/admin/…）
    └── _headers 的全局块 `/*`            ← 纯文本，Cloudflare 自己解析

函数响应（/api/*、/sitemap.xml、/feed.xml、/robots.txt、爬虫版首页）
    └── functions/_middleware.js          ← 兜住**所有**函数路由
            └── functions/_lib/security.js ← 6 个头的**唯一来源**
```

要点：

- **中间件必须放在 `functions/` 根目录**，只有这个位置能覆盖全部路由。
  放进 `functions/api/` 就会漏掉 `/sitemap.xml` 这些根路径端点。
- **必须导出 `onRequest`**（不是 `onRequestGet`）。写接口全是 POST / DELETE，
  写成 `onRequestGet` 等于只覆盖一半。
- 中间件**只加不删**：只 `set()` 那 6 个头，绝不碰
  `Content-Type` / `Cache-Control` / `Set-Cookie`。

## ⚠️ 为什么「只加不删」是硬约束

`_headers` 给静态资源发的是**缓存策略**（`/assets/*` 的 `max-age=86400 + swr`、
`/` 的 `max-age=0 + swr=300`、`/generated/covers.json` 的 60s）。
中间件如果写成 `new Response(res.body, { headers: 我自己拼的一份 })`，
就会把 `_headers` 那份**整份丢掉** —— 全站缓存策略当场崩。

而 `Set-Cookie` 更不能丢：**登录 / 登出全靠它**。中间件重造响应时若只抄了几个
自己关心的头，登录会静默失效。

所以 `withSecurityHeaders()` 的做法是**用原响应自身当 init**，把
`status` / `statusText` / `headers` 逐项带过去，再逐个 `set()` 那 6 个头：

```js
const out = new Response(res.body, {
  status: res.status, statusText: res.statusText, headers: res.headers,
});
for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
```

`new Headers(res.headers)` 会**保留 `set-cookie` 的多个值**，这一点有守护盯着。

## 头值的取舍（每一处都有理由，不是抄模板）

| 头 | 值 | 为什么是这个值 |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | JSON 被当 HTML 解析是 XSS 的经典入口 |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | 跨站不外泄完整 URL（含 `?post=<slug>`） |
| `Strict-Transport-Security` | `max-age=31536000` | ⚠️ **不带 `includeSubDomains`**：`pages.dev` 是所有 Cloudflare Pages 项目共用的域，加了等于替别人的项目做主；更**不带 `preload`**（要提交进浏览器预加载列表，撤不回来） |
| `X-Frame-Options` | `DENY` | 全仓 0 个 `<iframe>`，本站不需要被任何地方嵌入 |
| `Permissions-Policy` | 见下 | ⚠️ **刻意不列** `clipboard-write` / `clipboard-read` / `web-share` |
| `Content-Security-Policy` | `object-src 'none'; base-uri 'self'; frame-ancestors 'none'` | CSP 里**不需要 nonce** 的那一半 |

### Permissions-Policy 是反查了站内真实用法才定的

`assets/app.js` 里「复制链接」用 `navigator.clipboard`（:682/698/699/990）、
「分享」用 `navigator.share`（:824/870）。
把 `clipboard-write=()` 或 `web-share=()` 写进去，等于**亲手把这两个按钮弄坏**。
守护里有一条专门反查：从 `app.js` 里数出站点真在用的能力，再断言头里没禁它们。

实际下发：

```
geolocation=(), camera=(), microphone=(), payment=(), usb=(), magnetometer=(),
gyroscope=(), accelerometer=(), midi=(), serial=(), hid=()
```

## ⚠️ CSP 只上了一半 —— 另一半为什么不能顺手加

**已上（零风险）**：`object-src 'none'` / `base-uri 'self'` / `frame-ancestors 'none'`。
依据：全仓 0 个 `<object>` / `<base>` / `<iframe>`（真 grep 过，不是猜的）。

**刻意没上**：`script-src` / `style-src` / `default-src`。
页面里有 **3 段内联 `<script>`**（`index.html:63/110/643`），
`build.mjs` 还会把**整张 `assets/style.css` 内联进 `<head>`**（见 `docs/first-paint.md` §四），
`app.js` 也在运行时注入样式。
直接上 `script-src 'self'` 会**当场白屏**。

要上这一半，需要：给内联块算 `sha256` 或发 `nonce`（`index.html` 是构建期产物，
`build.mjs` 里算 hash 最自然），并让运行时注入的样式也带上 —— 是独立一项，工作量不小。

> 💡 补上之后**不会**和现在这三条打架：多个 CSP 头 / 多条指令是**取交集**的，
> 这里只收窄了三条，不构成阻碍。

## 两份拷贝必须手工同步

`_headers` 是纯文本，没法 `import`，所以同一批值存在**两份**：`_headers` 一份、
`security.js` 一份。谁也不会替你同步，`verify-security-headers.mjs` 逐个头比对
（键相同 + 值逐字相同 + 同一个头不许被两条 `_headers` 规则重复设置），
只改一边就判红。

## 怎么验证

```bash
# 离线（进套件，21 项里的一项）：74 项断言 + 4 项负向自证
node scripts/verify-security-headers.mjs

# 线上（依赖网络，不进套件）：有 PASS/FAIL 与退出码
node scripts/audit-live.mjs
```

离线守护用的是**真调用**（`functions/` 复制到临时沙箱 → 动态 import → 拿假
`context` / 假 `caches` / 假 D1 跑），不是 grep 源码。核心几组：

| 组 | 盯什么 |
|---|---|
| `[1]` | 两份拷贝逐字一致、CSP 里不许出现 `script-src`、Permissions-Policy 不许禁掉在用的能力 |
| `[2]` | 中间件只加不删：`Cache-Control` 逐字节不变、多个 `Set-Cookie` 一个不丢、头集合恰好 = 原有的 ∪ 6 个、流式 body 不被吃掉、304 不炸、幂等 |
| `[3]` | 包装抛异常时放行原响应 **且 `console.error` 留痕**（不许静默） |
| `[4]` | 三个爬虫端点的缓存：成功可缓存 + 写边缘缓存、**命中缓存时完全不碰 D1**、失败必须 `no-store` 且不写缓存 |

> ⚠️ `[2]` 里那条「304 + 空 body」不是凑数：`new Response(body, res)` 在
> 「无 body 状态码 + 非 null body」时会抛 —— 这正是**将来有人改坏这一层时最可能踩的形态**，
> `[3]` 的优雅降级测试就是拿它当注入点的。

### 线上验收的 12 条判据

见 `audit-live.mjs` 末尾。最值得留意的三条：

1. **函数响应全都有 6 个安全头** —— 离线的假 context 证明不了「运行时接线」，
   只有线上能证明根中间件真的挂上了。
2. **静态资源的 `Cache-Control` 逐字未变** —— 本次改动**最大的回归风险**就在这里。
3. **`/api/logout` 的 `Set-Cookie` 还在** —— 不需要登录态就能端到端验证
   「中间件没把 cookie 吃掉」。

⚠️ 还有一条**负向对照**：拿一个**不存在的 slug** 探爬虫注入，必须**不**注入。
原因是外壳 `index.html:378` 本来就写着空的 `<!--SSR-BODY-START--><!--SSR-BODY-END-->` 占位 ——
没有这条对照，「正文块存在」可能只是匹配到了占位（本次验收就踩过这个假结论）。

## ⚠️ 部署传播不是瞬时的

`_headers` 改完刚部署的几十秒内，可能撞上**还没换新的边缘副本**：那份副本只有原本那 2 个头
（`nosniff` + `referrer-policy`），恰好缺新加的 4 个。
2026-09-17 第一次跑线上验收就踩了，隔一分钟同一批 URL 再探就齐了。

这个签名很好认：**刚好缺新加的 4 个、却带着原本的 2 个** ⇒ 是旧副本，不是配置写错。
`audit-live.mjs` 会专门把这句话打出来，免得下次误判。

## 改动前后怎么对照

改动前的基线已存档在 `.diag/audit-before.txt`：**7 条「不许回归」的判据全绿、
5 条「应该修好」的判据全红、退出码 1**。改完 `.diag/audit-after.txt` 全绿、退出码 0。
两边用的是同一个脚本 —— 判据要是恒真，改动前就不会红。
