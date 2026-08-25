# 国内加速方案：静态前端走国内 CDN，动态接口留 Cloudflare

> 背景：经实测，把 `blog.zhongfangxin682.workers.dev` 换成 `blog-6p3.pages.dev` 后，首次加载依旧慢。
> 已确认瓶颈 **不是代码/缓存，而是 Cloudflare 在大陆没有节点**——浏览器请求要跨境到境外边缘（DNS+TLS+RTT 综合 1–3 秒起）。
> 静态预渲染只解决了"边缘命中后的源站耗时"，消除不了"用户 → 境外边缘"这段跨境延迟。
> 本方案通过**动静分离**治本：静态资源搬国内 CDN 秒开，动态接口继续走 Cloudflare 异步调用。

---

## 一、目标架构（动静分离）

```
用户浏览器（赣州）
   │
   ├─ 首屏 HTML / CSS / JS / generated/*.json  ──▶ 国内 CDN（腾讯云 COS+CDN / EdgeOne / 阿里云 OSS+CDN）
   │                                              同源，国内节点，首屏 ≈ 几十~几百 ms
   │
   └─ /api/* 动态请求（评论 / 阅读数+1 / 登录 / 发布）──▶ Cloudflare Pages Functions（blog-6p3.pages.dev）
                                                    跨境异步，1–3s，但非阻塞首屏
```

收益：
- **首屏与文章详情秒开**（静态资源国内节点直出，这是用户体感最痛的点）。
- 动态交互（评论、阅读数、登录）仍跨境，但都是**异步/非首屏**，用户几乎无感（评论提交后本地先乐观更新再同步）。

---

## 二、需要改动的两处代码

### 1. 前端 `assets/app.js`：API 走绝对地址 + 跨域带凭据

现状：所有请求都是相对路径 + `credentials: "same-origin"`（同域）。搬到国内 CDN 后，前端与 API 不同源，必须改。

**(a) 新增 API 基地址**（建议从 `index.html` 的 meta 读取，便于多环境切换）：

`index.html` 的 `<head>` 加：
```html
<meta name="api-base" content="https://blog-6p3.pages.dev" />
```

`assets/app.js` 顶部：
```js
const API_BASE = (document.querySelector('meta[name="api-base"]') || {}).content
  || "https://blog-6p3.pages.dev";
```

**(b) 把 `/api/...` 请求改为 `${API_BASE}/api/...`，`/generated/...` 保持相对**（静态在国内同源）：
```js
// 改前
const res = await fetch("/api/posts", { credentials: "same-origin" });
// 改后
const res = await fetch(`${API_BASE}/api/posts`, { credentials: "include" });
```
涉及的全部调用（已 Grep 定位）：
`/api/posts`、`/api/posts/detail`、`/api/posts/view`、`/api/posts/comments`、
`/api/me`、`/api/login`、`/api/register`、`/api/logout`、`/api/posts/manage`、`/api/posts/search`。

`/generated/posts.json` 与 `/generated/posts/<slug>.json` **保持相对路径**（它们在国内 CDN 上，同源更快）。

`credentials` 全部由 `"same-origin"` 改 `"include"`（跨域也要带 Cloudflare 域的 auth cookie）。

### 2. Cloudflare Functions：统一加 CORS 头（否则跨域请求被浏览器拦截）

现状：Functions **无任何 CORS 头**（之前同域不需要）。跨域后必须加，否则前端拿不到响应。

**推荐用 `_middleware.js` 统一处理**（覆盖所有 `/api/*`，无需逐个文件改）：

`functions/_middleware.js`：
```js
const ALLOWED_ORIGIN = "https://你的国内CDN域名"; // 例如 https://blog.your-cn-domain.com

export async function onRequest(context) {
  const { request, next } = context;
  // 预检
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request),
    });
  }
  const res = await next();
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(request))) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  // 仅在白名单源上加 CORS，避免完全开放
  const allow = origin === ALLOWED_ORIGIN ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}
```
`ALLOWED_ORIGIN` 设成你国内 CDN 绑定的域名（写死即可，或用 Functions 环境变量）。

---

## 三、国内托管选项对比

| 方案 | 静态部署 | 国内节点 | 成本 | 备注 |
|---|---|---|---|---|
| **腾讯云 COS + CDN** | 上传 `index.html`/`assets`/`generated` 到桶，开 CDN 加速 | ✅ 多节点 | 存储近乎免费；CDN 流量计费，个人博客约 ¥几~十几/月 | 最通用、可控；需配 CDN 域名 + HTTPS |
| **腾讯云 EdgeOne Pages** | 类似 Pages，支持静态 + 边缘函数 | ✅ 国内边缘 | 有免费额度 | 若后续想把动态也挪过来可扩展，但 Functions+D1 仍在 Cloudflare，本方案只放静态 |
| **阿里云 OSS + CDN** | 同 COS | ✅ 多节点 | 类似 | 看已有账号选 |
| **Cloudflare Pages（现状）** | — | ❌ 无大陆节点 | 免费 | 仅保留动态 API |

> 推荐：**腾讯云 COS + CDN**（最稳、成本最低、文档全）。已有腾讯云账号直接上。

---

## 四、部署流程

1. **构建静态产物**：本地或 CI 跑 `node build.mjs` 生成 `generated/`（`index.html` + `assets` + `generated` 即为完整静态站点）。
2. **上传到国内 CDN**：
   - COS：用控制台/CLI（`coscli`）把 `index.html`、`assets/`、`generated/` 同步到桶，开静态网站托管 + CDN 加速域名（如 `blog.your-cn-domain.com`）。
   - 或 EdgeOne Pages：把这三个目录推上去。
3. **配置 CDN 域名 HTTPS**（腾讯云免费证书即可）。
4. **Cloudflare 侧**：保持 `blog-6p3.pages.dev` 的 Functions 运行；加 `_middleware.js` 的 CORS；把 `ALLOWED_ORIGIN` 设为你的国内 CDN 域名。
5. **前端改完重新部署到国内 CDN**（app.js 的 `API_BASE` + `credentials` 改动要生效）。

> 可选自动化：在 `build.mjs` 末尾或单独的 `deploy-cn.mjs` 里，构建完用 COS SDK 直接同步产物到桶，一条命令完成"生成 + 国内发布"。需要腾讯云 SecretId/SecretKey（放环境变量，不入库）。

---

## 五、成本估算

- **COS 存储**：站点总体积（HTML+JS+CSS+generated 的 base64 封面）估计 < 50MB，存储费 ≈ ¥0（免费额度内）。
- **CDN 流量**：个人博客月流量通常 1–10GB，按 ¥0.2/GB 约 ¥2–¥20/月；新站基本在免费或极低区间。
- **Cloudflare Functions + D1**：动态接口仍走 Cloudflare，免费额度足够个人博客。

---

## 六、风险与权衡

| 项 | 说明 |
|---|---|
| 动态接口仍跨境 | 评论提交、阅读数+1、登录会有 1–3s 延迟；但这些是异步非首屏，前端可做乐观更新，体感影响小。 |
| CORS + Cookie 安全 | `Access-Control-Allow-Credentials: true` 必须配合**具体白名单源**（不能 `*`），已在上文 `_middleware.js` 限定 `ALLOWED_ORIGIN`，安全可控。 |
| JWT cookie 跨域 | `credentials: "include"` + 请求目标为 Cloudflare 域，浏览器会正确携带该域 auth cookie，登录态不受影响。 |
| 发布流程变两步 | 改代码 → 推 Cloudflare（Functions）；改文章/前端静态 → 同步国内 CDN。可脚本化合并。 |
| SEO | 国内 CDN 上的 `index.html` 仍是 JS 渲染，搜索引擎抓取同前。如需国内 SEO 可后续做 HTML 预渲染，本方案不强制。 |

---

## 七、验证清单

1. 用国内 CDN 域名打开首页：DevTools Network 里 `index.html`/`assets/app.js`/`generated/posts.json` 应来自国内 CDN 节点（看响应 IP/服务器头），首屏明显变快。
2. 打开文章：`/generated/posts/<slug>.json` 国内 CDN 直出，详情秒开。
3. 评论 / 阅读数 +1 / 登录：浏览器 Console 无 CORS 报错；评论能提交成功、阅读数递增（动态走 Cloudflare 异步，稍慢但可用）。
4. 发布新文章：Cloudflare 触发 Deploy Hook 重部署 → `generated/` 更新 → 同步到国内 CDN（若脚本化则自动；否则手动再同步一次）。

---

## 八、回滚

若国内 CDN 出问题，直接把访问入口切回 `blog-6p3.pages.dev`（Cloudflare 全栈同源、无需 CORS），无数据风险。前端 `API_BASE` 改回空（同源相对路径）即可还原。

---

## 九、决策前置条件

推进此方案需要你提供（任选其一对等凭证，**只用于部署，不入库**）：
- 腾讯云 SecretId / SecretKey（用于 COS 上传 + CDN 刷新），或
- 阿里云 OSS 等价凭证。

确定平台后，我可以：① 改 `app.js` + 写 `functions/_middleware.js`（CORS）；② 写 `deploy-cn.mjs` 一键构建并同步国内 CDN；③ 给你控制台逐项配置清单。
