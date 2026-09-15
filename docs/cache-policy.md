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
- 🚫 别对 `generated/*.json` 用 `force-cache`（永不校验，封面换名后会集体死链，见 `verify-frontend-guards` 的 `[1]` 段）。
- 🚫 别为了「统一风格」把所有 `no-store` 一起改掉 —— 本文件列的那几条是安全边界。
- ⚠️ 改完跑 `node scripts/verify-frontend-guards.mjs`，并跑一遍 `.diag/negative-cache.mjs` 确认断言有效。
