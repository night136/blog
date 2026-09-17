# 接口缓存策略：哪些能缓存、哪些绝对不能

> 2026-09-15。起因：有人问「`cache:"no-store"` 可以改成有缓存吗」。
> 相关守护：`scripts/verify-frontend-guards.mjs` 的 `[5]` 段（11 项，含变异自检）。
> 实验脚本（均在 gitignore 的 `.diag/`）：`cache-headers.mjs`、`cache-behavior.mjs`、`cache-e2e.mjs`、`negative-cache.mjs`。

## 先纠正一个前提：它和服务端的头在打架

服务端**早就在发**可缓存的头：

| 接口 | 服务端发的 Cache-Control |
|---|---|
| `/api/posts` | `public, max-age=60, s-maxage=60` |
| `/api/posts/meta` | `public, max-age=60, s-maxage=60` |
| `/api/config` | `public, max-age=300, s-maxage=300` |
| `/api/posts/detail` | `public, max-age=180, s-maxage=180`（写在 Cache API 那份里） |
| `/generated/*` | `_headers` 里配的 SWR |

而前端一律写 `cache: "no-store"`。`no-store` 是**浏览器端**指令（「不查缓存、也不存」），
它管不到 Cloudflare 边缘（`s-maxage` + `Cache API` 那层照常工作），但会把 `max-age` 那层**整个废掉**：

```
curl 实测：/api/posts 连续两次 → cf-cache-status: HIT → HIT
           （边缘一直命中，但浏览器每次都还要跨境去边缘取一趟）
```

## 实测：差多少

真浏览器（本机 Edge + CDP），`Network.responseReceived.response.fromDiskCache` 判定，
同一次会话内两次 fetch 同一 URL（`.diag/cache-behavior.mjs`）：

| 接口 / 模式 | 第 1 次 | 第 2 次 | fromDiskCache |
|---|---|---|---|
| `/api/posts` `no-store`（改前） | 949ms | **199ms** | false → false |
| `/api/posts` `default`（改后） | 774ms | **2ms** | false → **true** |
| `/api/config` `no-store`（改前） | 273ms | **239ms** | false → false |
| `/api/config` `default`（改后） | 194ms | **3ms** | false → **true** |
| `/api/config` `reload` | 230ms | 211ms | false → false |

⚠️ 这 200ms 左右是**在开发者机器上**测的。`pages.dev` 在大陆无节点，
真实跨境访问时这个「去边缘取一趟」的成本要高得多（用户侧常见的 1–3s 抖动就有它的份）。

## 改了什么（只改公开只读的两个）

| 接口 | 改动 | 理由 |
|---|---|---|
| `/api/config` | `no-store` → `default` | 响应只有公开的 Turnstile Site Key，服务端 `max-age=300`。改 key 后最多 5 分钟生效 |
| `/api/posts` | `no-store` → `default` | 返回 `id/slug/title/date/tag/summary/cover/author/字数/阅读数` —— **无任何登录态**。它是降级路径（静态快照不可用时才走） |

## 没改、也不该改的（这是安全边界，不是性能旋钮）

| 接口 | 为什么必须 no-store |
|---|---|
| `/api/me` | 它回答「**谁在登录**」。缓存了，同浏览器换账号/登出后重进，会看到上一个身份的界面 |
| `/api/guestbook` | 响应含 `canDelete` / `currentUser`。缓存 30s，登出后仍会显示删除按钮（点下去会被后端拒绝，但界面已经错了） |
| `/api/guestbook` 分页 | 同上（`notes` + 权限态） |
| `/api/posts/search` | 结果会因文章增删而失效 —— 删掉的文章若被缓存，点进去就是 404。且没有缓存价值（非首屏路径） |
| `/api/posts/meta` | 它是**新鲜度探针**（`count` + 最新 slug），存在的唯一目的就是发现「快照过期了」。给它加缓存等于自废武功：发布后 60s 内自检会拿到旧 `count`，误判快照是新的 |

## 顺带补的服务端第二道防线

前端写 `no-store` 只是**第一道**。以下三处原本靠「浏览器对无缓存头响应的启发式规则」兜着，
属于不可控，已显式钉住：

- `functions/api/guestbook.js`：原本**无论登录与否都发 `public, max-age=30`** ——
  一个含 `canDelete:true` 的响应被标成 `public`（＝允许任何缓存存储）。
  其实现按身份分：`username ? "private, no-store" : "public, max-age=30, s-maxage=30"`。
  ⚠️ 边缘那份 `Cache API` 的键已含 `_u` 登录态维度（见 `guestbook.js` 的 `cacheUrl`），
  所以改响应头**不影响**边缘缓存行为，只是不让权限态落进浏览器缓存。
- `functions/api/me.js`：原本**没有任何缓存头**。已显式 `no-store`。
- `functions/api/posts/search.js`：原本没有任何缓存头。已显式 `no-store`。

## ⚠️⚠️ 一条最容易搞错的事：只加 `Cache-Control` 标头**不等于**边缘缓存

2026-09-17 做 audit §七 #11（`/sitemap.xml` `/feed.xml` `/robots.txt` 以前**完全没有**缓存头）
时，先用「加标头」的办法改了一版，上线后看着头都在、判据全绿 —— 但**边缘根本没缓存**。

一次性探针（`/api/_probe-a`，与 `/api/posts/meta` 同 Content-Type、同 `s-maxage`，
唯一差别是没用 Cache API）实测：

| 端点 | 用了 Cache API | `s-maxage` 标头 | 实测结果 |
|---|---|---|---|
| `/api/posts/meta` | ✅ | ✅ | `cf-cache-status: HIT`，`age` 逐次递增 15→25→33 |
| `/api/posts` | ✅ | ✅ | `HIT` |
| `/api/_probe-a`（探针） | ❌ | ✅ | **连 `cf-cache-status` 都不出现** ⇒ 边缘未缓存 |
| `/api/_probe-b/c/d`（探针，换 Content-Type / 加 SWR） | ❌ | ✅ | 同上，全都不缓存 |

⇒ **根因不是 Content-Type、也不是 SWR**（这三组变量都单独隔离过），
而是 **Pages Functions 的响应不会因为 `s-maxage` 自动进 CDN 缓存 —— 必须用 Cache API 显式写。**

同一条结论仓库里其实早就写着，只是没被当判据用：

```js
// functions/api/posts.js:58
// 边缘缓存：Pages Functions 不会因 s-maxage 标头自动走 CDN 缓存，必须用 Cache API 显式存边缘。
```

所以现在的判据不是「有没有 `s-maxage`」，而是**「命中边缘缓存时会不会还去打 D1」**：

```js
const cache = caches.default;
const cacheKey = new Request(request.url);
try { const hit = await cache.match(cacheKey); if (hit) return hit; } catch (_) {}
// …成功路径…
try { await cache.put(cacheKey, res.clone()); } catch (_) {}
```

`verify-security-headers.mjs` 的 `[4]` 段用**假 `caches` + 假 D1** 验这条：
先把缓存喂热，再把 D1 换成**必炸**的实现 —— 只要还能拿到 200 和正文，就证明它压根没走到 D1。

## 三个爬虫端点的缓存策略（audit §七 #11）

| 端点 | Cache-Control | 为什么 |
|---|---|---|
| `/sitemap.xml` | `public, max-age=300, s-maxage=1800, swr=86400` | 内容只在发文时变。以前没有缓存头 ⇒ 每个爬虫每次来都打一遍 D1 |
| `/feed.xml` | 同上 | 与 sitemap 是同一批数据的两种呈现 |
| `/robots.txt` | `public, max-age=3600, s-maxage=3600, swr=86400` | **不读 D1**（只用 `env.SITE_URL`），缓存只为省一次函数调用；但写错抓取策略代价高，所以边缘 TTL 只给 1 小时 |

⚠️ **错误分支必须 `no-store`**，而且**绝不能写进 Cache API**：

- sitemap 没配 D1 / 读库抛异常 → 500 + `no-store`，且**不** `cache.put`。
  D1 抖一次会让「坏 sitemap」在每个爬虫面前挂半小时（还被搜索引擎长期记住），比不缓存更糟。
- feed 读库失败 → 仍然回 200（订阅器对非 200 常直接报「源坏了」），但 `no-store` + **不** `cache.put`。

⚠️ 顺带补的：这两个端点的 `catch` 里原来**没有 `console.error`** ——
sitemap 只把错误写进 XML 注释、feed 只往通道里塞一行注释，日志里完全查不到。
属于本项目反复踩的「三类静默失败」之一，已补上。

## 复测方法

```bash
# 1) 看线上真实响应头（含边缘命中情况）
node .diag/cache-headers.mjs

# 2) 真浏览器：default vs no-store 的实际差别
node .diag/cache-behavior.mjs

# 3) 端到端：两轮加载，看哪些接口命中本地缓存、哪些没有
node .diag/cache-e2e.mjs

# 4) 负向验证：把断言故意改坏，确认它们会红
node .diag/negative-cache.mjs

# 5) 守护
node scripts/verify-frontend-guards.mjs
```

`cache-e2e.mjs` 的预期输出（已实测通过）：

```
  接口                  第 1 轮        第 2 轮
  /api/config         网络 + 缓存     缓存 + 缓存     ← 公开数据生效
  /api/guestbook      网络            网络            ← 未被缓存（正确）
  /api/me             网络            网络            ← 未被缓存（正确）
```

## 铁律

- ✅ 要缓存一个接口，先问：**响应里有没有「谁在登录 / 能不能操作」**。有 → `no-store`，没得商量。
- ✅ 改 `default` 的前提是**服务端也发了 `max-age`** —— 只改前端没用（服务端 `no-store` 仍然会赢）。
- ⚠️⚠️ **反过来的前提也成立**：只在服务端加 `Cache-Control` 也**不会**让 Functions 进边缘缓存 ——
  想真的少打 D1，得用 `caches.default` 显式写（见本节顶部那组探针对照）。
  验证方法只有一个：把 D1/上游换成必炸的实现，看边缘命中时还走不走得到它。
- 🚫 别对 `generated/*.json` 用 `force-cache`（永不校验，封面换名后会集体死链，见 `verify-frontend-guards` 的 `[1]` 段）。
- 🚫 别为了「统一风格」把所有 `no-store` 一起改掉 —— 本文件列的那几条是安全边界。
- 🚫 错误 / 失败响应**永远不许**加缓存头，也不许 `cache.put`。
- ⚠️ 改完跑 `node scripts/verify-frontend-guards.mjs` + `node scripts/verify-security-headers.mjs`，
  并跑一遍 `.diag/negative-cache.mjs` 确认断言有效。
