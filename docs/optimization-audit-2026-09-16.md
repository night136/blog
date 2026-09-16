# 博客全站优化审查（2026-09-16）

> 起因：用户问「整个还有什么功能可以优化」。
> 本报告只列**有实测证据**的项；纯猜测、无法验证的一律不写。
> 与既有审查的关系：`site-review-2026-09.md`（09-14）的「已知未改」20 项，本报告**逐条核实了当前状态**（见 §七）。

---

## 一、这次是怎么查的

| 手段 | 脚本 | 拿到什么 |
|---|---|---|
| 线上响应头 / 压缩 / 缓存 | `scripts/audit-live.mjs` | 每类资源的 `content-encoding`、`cache-control`、`etag`、TTFB |
| 爬虫视角复测 | `scripts/audit-spider.mjs` | SSR 正文长度、`<title>`、canonical 条数、`og:image` |
| 真实浏览器冷缓存性能 | `scripts/perf-probe.mjs --cold` | 导航各阶段、FCP/LCP、资源时序、长任务、控制台错误 |
| **对照实验** | 同上，打 `/404.html` | 隔离出「阻塞样式表」的**净代价** |
| 静态代码审查 | — | `functions/` 全部 + `assets/app.js` 关键路径 |

> `audit-live.mjs` 与 `audit-spider.mjs` 本次已**入库**（原先只在 `.diag/` 下、不入版本库，报告引用会悬空）。
> 两者都支持参数：`node scripts/audit-live.mjs [baseUrl]`、`node scripts/audit-spider.mjs [slug]`。
> ⚠️ 它们**不进 `run-all.sh`**：依赖线上网络，作为 CI 判据会很脆弱（名字是 `audit-*` 不是 `verify-*`，`verify-suite-coverage` 不会管它们）。

---

## 二、体检基线（线上实测，冷缓存）

| 指标 | 首页 | `/404.html`（对照：纯内联 CSS，无外部样式表） |
|---|---|---|
| TTFB(HTML) | 762 ms | 1037 ms |
| **TTFB → 首绘 增量** | **658 ms** | **55 ms** |
| FP / FCP | 1420 ms | 1092 ms |
| LCP | 1936 ms（元素是 `P`） | 1092 ms（元素是 `H1`） |
| 长任务(>50ms) | 0 个 | 0 个 |
| 控制台错误 | 0 | 0 |
| Brotli | ✓ 已启用 | — |

> ⚠️ TTFB 本身波动大（跨境，连测 5 次 195~223ms，但首次导航会到 762ms）。
> 所以**对比口径用「TTFB → FCP 的增量」**，不用绝对 FCP —— 前者把网络抖动剔掉了。

---

## 三、🔴 P0 — 首绘被阻塞的外部样式表卡住（最大单项收益）

### 证据链（三步，互相独立）

1. **增量对比**：首页从 HTML 到首绘要 **658ms**；同一个站、同一台机器、同一时段，`/404.html` 只要 **55ms**。两者唯一的差别就是后者**没有外部样式表**（774 字节的 HTML，CSS 全内联）。
2. **资源时序**：`/assets/style.css` 实测传输 32868 B（br）、总耗时 **534 ms**，FCP 1420ms 紧跟在 style.css 完成后。
3. **排除法**：长任务 0 个、控制台 0 错误、DOM 节点仅 583 —— 首绘延迟不是 JS 或 DOM 造成的。

⇒ **从 HTML 到首绘的 658ms 里有约 600ms 是在等一张 108KB（br 32.9KB）的阻塞样式表。**

### 为什么这件事值得做

- 首绘是用户对「站点快不快」的**唯一主观判据**。658ms → 约 100ms 是**6 倍**量级的改善。
- 这是**唯一一个**能一次性改善所有页面（首页/文章/留言墙）的优化。
- 现在的 index.html 已经内联了「变量 + 防闪 + 布局骨架 + 卡片入场动画 + 移动端兜底」，**证明内联这条路在本项目可行** —— 只是范围还不够。

### 修法（两条路，风险不同，必须二选一并实测）

| 方案 | 做法 | 收益 | 风险 |
|---|---|---|---|
| **A 保守** | 扩大内联范围：把首屏可见区域的规则（topbar / hero / 布局栅格 / 卡片 / 侧栏）也内联进 `<head>` | 中（可能 200~400ms） | 低。HTML 体积增大约 6~8KB（br 后） |
| **B 激进** | 拆成 `critical.css`（内联）+ `rest.css`（首绘后由 app.js 注入，**复用现成的字体注入手法**） | 高（接近 658ms 全拿） | 中。注入晚了会 **FOUC**（首绘后样式跳变），必须实测 |

### 🚫 三个已知雷区（本项目都踩过）

- **不能用 `media="print" onload` 切换**：小米/360 兼容模式支持不良，会导致样式表**永远不生效**，项目已因此回滚过一次（见 `docs/first-paint.md`、`index.html` 第 184 行注释）。
- **不能把字体注入的注释当成 style.css 的方案**：那两段注释现在是混在一起的（见 §十）。
- **注入式方案必须造一次真实调用证伪「不会 FOUC」**：不能只看代码写完了。历史上「假兜底」已经骗过我们一次（`89838d8`，注释写着「等事件自动触发」而那个事件会抛异常）。

### 前置验证要求（做之前先建判据）

- 在**真实浏览器**里同时量 FCP 与 **CLS**（样式跳变会体现为 CLS）。
- 冷缓存 + 暖缓存各跑一次（暖缓存下网络代价消失，若仍有跳变说明是注入时机问题，不是网络问题）。
- 移动视口单独跑（窄屏分支的规则更多）。

---

## 四、🟠 P1 — 首屏白下 24.8KB：两个 logo 是同一张图

### 证据

```
本地 md5：assets/logo-avatar.png = bead8fd2d4ff3b5c10f63f532286da47
          assets/logo-hero.png   = bead8fd2d4ff3b5c10f63f532286da47   ← 完全相同
线上 etag：/assets/logo-avatar.png?v=c9278a5d61 → "dd8296b56334dd36216deaf61312f81e"
          /assets/logo-hero.png?v=c9278a5d61   → "dd8296b56334dd36216deaf61312f81e"  ← 同一个 etag
```

冷缓存实测（真实浏览器）：两个请求**同时**在 +772ms 发起，各自传输 **24830 B**（耗时 273ms / 300ms）。
`index.html` 里确实用了**两个不同的 URL**：

```html
209: <img class="avatar"      src="assets/logo-avatar.png" ... width="56" height="56">
250: <img class="hero-avatar" src="assets/logo-hero.png"   ... width="72" height="72">
```

⇒ 浏览器按 URL 做缓存键，**同一张图被下载了两次**。

### ✅ 已修（提交 `2733ab4`）

用 `.diag/count-logo-requests.mjs`（真浏览器 + 全新 profile + `Network.clearBrowserCache`）前后各量一次：

| | logo 请求数 | 传输字节 |
|---|---|---|
| 改前（线上） | 2（两个 URL 各 1 次） | **49665 B** |
| 改后 | **1** | **24724 B** |

⇒ 首屏省 **24941 B（≈24.4 KB）**、少一次往返，渲染零变化。

**实际做法与原计划有一处不同：没有删文件。** 原计划写「只留一份、删掉另一个」，但任何
**陈旧 HTML 外壳**（Cloudflare 边缘 `swr` 副本、用户已缓存的 HTML）仍引用着
`assets/logo-hero.png`，删了就 404 破图 —— 这正是 `build.mjs` 注释里记录过的 2026-09-12
事故类型（哈希文件名随部署消失 ⇒ 陈旧外壳 4/4 次 404）。

收益来自「**只有一个被引用的 URL**」，与文件是否删除无关。所以 `logo-hero.png` 保留为
**兜底副本**（不再被引用）。配套：

- `index.html` 两处头像统一用 `assets/logo-avatar.png`（渲染尺寸由 `width/height` 决定，与下载份数无关）；
- `build.mjs` 注入正则写成 `logo-(?:avatar|hero)`，把历史引用顺手收敛回唯一 URL（构建期防复发）；
- `verify-avatar-asset` 新增 4 条不变量：`index.html` 里 logo 引用**去重后必须只有 1 个 URL**、
  两侧头像指向同一 URL、兜底副本与主素材**字节必须相同**（漂移会「只在缓存命中时画出旧头像」，
  这种差异最难查）、`build.mjs` 必须保留归一化与 `?v=` 注入；
  同时把 `logo-hero.png` 改成「允许不存在」，将来清掉兜底副本不该判红。

⚠️ 将来真要删兜底副本，先确认线上已无 `logo-hero.png` 引用、且过了至少一个 `swr` 周期。

---

## 五、🟠 P1 — 登录是全站唯一没有防护的入口

### 现状（代码核实）

| 入口 | Turnstile 人机验证 | 失败次数限制 |
|---|---|---|
| `POST /api/register` | ✅ 有（`verifyTurnstile`） | — |
| `POST /api/guestbook` | ✅ 有 | ✅ 有（`DAILY_LIMIT = 5`） |
| **`POST /api/login`** | ❌ **无** | ❌ **无** |

`login.js` 里只有防**用户名枚举**的措施（两分支文案一致 + 假哈希 + 时序防护），但**没有任何东西阻止反复尝试**。

⇒ 也就是说：注册口有人机验证挡着，**登录口没人管**。攻击者不需要注册，直接对着登录口无限试密码即可。

### 修法（三件，可分开做）

1. **给 login 挂 Turnstile**：与 register 共用一个 Site Key（前端已有 `renderTurnstile` / `renderRegisterTurnstile` 两套渲染，加第三套或复用即可）。
2. **基于 IP + 用户名的失败计数**：计数存 D1（新表 `login_attempts`），超过阈值后**递增延迟**而不是硬锁（硬锁会被用来 DoS 真实用户）。
   ⚠️ `getClientIp()` 已在 `functions/api/_lib/turnstile.js` 里，直接复用。
3. **PBKDF2 渐进升级**：现在 `iterations: 100000`（`auth.js:28`），OWASP 当前建议 600000。
   🚫 **绝不能直接把 100000 改成 600000** —— 所有现存密码会立刻全部校验失败。
   正确做法：把迭代数**写进 hash 字符串**（`pbkdf2$<iter>$<salt>$<hash>`），校验时按**存储的**迭代数算；老格式 `salt:hash` 按 100000 校验，**成功后顺手用新迭代数重写**。这样不用重置任何人的密码。

---

## 六、🟠 P1 — 首页就加载 Turnstile，而首屏完全用不到

### 实测

冷缓存首页上，Turnstile 相关请求：

```
/turnstile/v0/api.js?render=explicit   开始 +1604ms   耗时 866ms
/cdn-cgi/challenge-platform/...        开始 +2485ms   耗时 836ms
/cdn-cgi/challenge-platform/...        开始 +2483ms   耗时 826ms
challenges.cloudflare.com iframe       2 个           合计 1662ms
```

### 为什么是浪费

人机验证只有两个用途：**注册**、**留言墙**。首页列表、文章详情、归档、关于页**都不需要**。
而且这是**跨站资源**（`challenges.cloudflare.com`），在 pages.dev 这种「大陆无节点」的场景下，跨境往返尤其贵。

### 修法

把 `ensureTurnstileScript()` 从启动段推迟到**用户真的切到需要验证的视图时**（或视图激活后 `requestIdleCallback` 预加载脚本、但**不 render**）。
⚠️ 现有降级逻辑（`renderTurnstileFallback` / `retryTurnstile`）依赖「脚本就绪」状态，推迟后要确认这些路径仍成立，别造出第二个「假兜底」。

---

## 七、🟡 P2 — 09-14「已知未改」清单：20 项里 **12 项仍在**

逐条核实结果（✅=仍在，⚠️=部分/影响已降低）：

| # | 问题 | 核实 | 影响 |
|---|---|---|---|
| 8 | 登录无失败次数限制 | ✅ 仍在（`grep rate/attempt/lockout` 全后端只命中 guestbook） | **升 P1**，见 §五 |
| 9 | PBKDF2 10 万次 | ✅ 仍在（`auth.js:28`） | **升 P1**，见 §五 |
| 10 | 阅读量自增非原子 | ✅ 仍在 | 并发下计数偏差；改 `UPDATE … RETURNING views` 即可 |
| 11 | sitemap / feed / robots 无 `Cache-Control` | ✅ **实测确认**：三者响应头 `cache-control: —` | **每次请求都打 D1**；加上 `max-age` 即可 |
| 12 | 便签墙 2 次全表聚合 | ✅ 仍在（`DISTINCT substr(created_at,1,10)`） | 函数运算使索引失效，全表扫 |
| 13 | 注册先查重后插入 | ✅ 仍在 | 并发冲突时依赖 UNIQUE 兜底，但抛 500 而非 409 |
| 14 | 错误响应格式不统一 | ✅ 仍在 | `{error}` 与 `{ok:false,error}` 混用 |
| 15 | 灯箱无焦点管理 | ✅ 仍在（`role="dialog"` 零命中） | 键盘/读屏用户困在灯箱里 |
| 16 | 无 skip link / `aria-current` | ✅ 仍在（`aria-current` 只出现在轮播圆点） | 键盘用户要 Tab 过全部导航才能到正文 |
| 17 | `mdToHtml` 把 `# ` 渲染成 `<h2>` | ✅ 仍在 | 影响已降低（SSR 正文能被抓到之后） |
| 18 | 死代码 `gradFor()` | ✅ **确认**：全文件只出现 1 次（定义处），零调用 | 纯卫生 |
| 19 | 顶部 scroll 监听未节流 | ✅ 仍在 | 每次滚动读 `scrollY` + 2 次 `classList.toggle` |
| 20 | 返回列表不恢复滚动位置 | ✅ 仍在 | 从文章返回首页会跳回顶部（体验明显） |

> 另外 8 项（原 #1~#7 与爬虫正文）已在 09-14/09-15 修掉，本次复测确认有效。

---

## 八、🟡 P2 — 安全响应头有缺口，且 `functions/` 完全裸奔

### 实测（`audit-live.mjs`）

| 响应头 | 静态资源 | `functions/` 生成的响应（`/api/*`、`/sitemap.xml`、`/feed.xml`、`/robots.txt`） |
|---|---|---|
| `referrer-policy` | ✅ | ❌ |
| `x-content-type-options` | ✅ | ❌ |
| `content-security-policy` | ❌ | ❌ |
| `strict-transport-security` | ❌ | ❌ |
| `x-frame-options` / `frame-ancestors` | ❌ | ❌ |
| `permissions-policy` | ❌ | ❌ |

**根因**：`_headers` 只对**静态文件**生效，Functions 返回的响应不经过它。所以 `/api/*` 与三个 XML/TXT 端点连基础的 `nosniff` 都没有。

### 修法

在 `functions/` 侧统一加一层：新增 `functions/_lib/security.js` 的 `withSecurityHeaders(res)`，或直接用 Pages 的 `_middleware.js` 给所有响应兜一层。
⚠️ **CSP 要单独评估**：站点内联了 `<style>` 与 `<script>`（防闪、启动标记），上 `script-src 'self'` 会直接把它们全挡掉 —— 需要 nonce 或 hash，改动量不小，建议**先上其余四项**，CSP 另立一项。

---

## 九、🟡 P2 — 仓库卫生

| 项 | 体积 | 状态 | 建议 |
|---|---|---|---|
| `assets/uploads/微信图片_20260519215702.jpg` | 233 KB | **已入库，全仓库零引用** | 删（或确认它是否经 D1 的 cover 字段被外部引用） |
| `replace_logo.py`（根目录） | 5.2 KB | 一次性脚本，仅自我引用 | 删（已被 `scripts/build-avatar-asset.py` 取代） |
| `assets/logo-avatar.png` | 24 KB | 与 `logo-hero.png` **内容相同** | 见 §四 |
| `content/posts/*.md` | 5 个 + `index.json` | 迁移前备份（README 写「可留可删」） | 留着当离线备份或移出仓库 |
| `outputs/` | — | ✅ 已在 `.gitignore` | 无需处理 |
| `scripts/fixtures/`、`scripts/lib/` | — | ✅ **有用的**（农历黄金样本、SEO 渲染/摘要库） | **不要删** |

---

## 十、🟢 P3 — 文档债（但很容易害人）

`index.html` 里有两段**位置相邻、说的却是两回事**的注释：

- **第 46~56 行**：「⚠️ 这里刻意**不放** `<link rel="stylesheet">`：那条样式表未压缩 339KB、gzip 91KB…改由 app.js 在首绘之后动态注入」
- **第 184 行**：`<link rel="stylesheet" href="assets/style.css" />` —— 上面写着「完整样式表：**恢复阻塞加载**」

真相是：第 46 行的注释在讲**字体的样式表**（`fonts.font.im` 的 css2，339KB/gzip 91KB 正是 Noto Serif SC 的全套子集），字体确实改成首绘后注入了 ✅；
而 `assets/style.css` 是**阻塞加载**的（因为 media=print 事故）。

问题是那句「**这里**刻意不放」出现在 `preconnect` 上方，紧接着 130 行后就有一张阻塞样式表 —— 极易被读成「本站没有阻塞样式表」。

> **我这次就先后被它绕进去一次**：先在 §三 判断这条注释是「过时代码」，写下去之后才因为看数据（style.css 确实阻塞）回头确认它说的是字体。
> 一次误解就足以让人做出错误决策（比如去「修」一个本来正确的东西）。

**修法**：把两段注释物理分开 —— 字体那段紧贴 `preconnect`，`assets/style.css` 那行旁边明确写「**这是阻塞加载，理由见 `docs/first-paint.md`，不要改成 print/onload**」。

---

## 十一、✅ 实测正常、**不要动**的部分（防止过度优化）

这几项我一开始怀疑有问题，查清后确认是**设计如此**，写在这里免得下次重复怀疑：

| 项 | 一开始的怀疑 | 查清后的事实 |
|---|---|---|
| **canonical 有 2 条** | 双 canonical ⇒ 永不收录（历史事故） | **只有 1 条真实**。我数出 2 条是正则命中了 `index.html` 第 117 行 `<script>` 里的 **JS 块注释**文本（`像 <link rel="canonical"> 这类…`）。`verify-seo-render.mjs:276` 早就记录过这个坑，用的是紧正则 `<link rel="canonical" href=` |
| `/api/guestbook` 返回 `public, max-age=30` | 登录态接口怎能公开缓存 | **刻意设计**：`guestbook.js:146` 是 `username ? "private, no-store" : "public, max-age=30"`，且缓存键含 `_u`（`searchParams.set("_u", username \|\| "-")`）⇒ 不会串号 |
| `/api/posts/meta` 返回 `public, max-age=60` | 新鲜度探针自己缓存 60s，还探得到新文章吗 | **刻意设计**（`meta.js` 注释写明）。前端侧的 `no-store` 要求是**另一个维度**（浏览器层），两者不冲突 |
| 爬虫响应 `vary: null` | 边缘可能把爬虫版发给真人 | 不影响：爬虫分支带 `s-maxage=600`，真人分支是 `max-age=0`（**不写边缘缓存**）⇒ 真人的响应不会污染爬虫的缓存 |
| JSON-LD | 首页没有 | **文章页有**（`verify-seo-render` 覆盖）。首页无 Article schema 属正常 |

**其他已确认到位的**：
- 爬虫 SSR：`x-ssr-body=1`，正文 477 字符，`<title>` 正确替换为文章标题，`og:image` 指向正文图，canonical 指向文章 URL
- Brotli 已启用：`style.css` / `app.js` / 全部 JSON / XML 都是 `content-encoding: br`
- 懒加载已到位：`highlight.min.js`（119KB）仅当文章含 `<pre><code>` 才加载；`qrcode.js`（55KB）仅分享时加载
- 长任务 0 个、控制台 0 错误

---

## 十二、建议处理顺序

| 顺序 | 项 | 收益 | 风险 | 备注 |
|---|---|---|---|---|
| 1 | §四 重复 logo 合并 | 首屏 −24.8KB、−1 请求 | 极低 | 十几分钟，零悬念 |
| 2 | §五 登录加固（Turnstile + 失败计数） | 堵住唯一裸奔入口 | 低 | 可与 3 并行 |
| 3 | §三 style.css 不再阻塞 | **首绘 −600ms 量级** | 中 | **先建 CLS/FCP 判据再改** |
| 4 | §六 Turnstile 改按需 | −1.7s 网络/CPU（首页） | 低 | 注意降级路径 |
| 5 | §八 安全头统一 + §七 #11 缓存头 | 安全基线 | 低 | 一起做 |
| 6 | §七 #10 #12 #13 | 数据层正确性 | 低 | D1 侧改动 |
| 7 | §七 #15 #16 #19 #20 | a11y / 体验 | 低 | 可分批 |
| 8 | §九 §十 仓库卫生 + 文档债 | 长期可维护性 | 极低 | 顺手做 |

---

## 十三、本次已顺手修掉的（上一轮工作的收尾）

- 🐛 **`scripts/run-all.sh` 漏收录 `verify-avatar-asset`** —— 上一轮新写的 13 项素材守护**从未被主入口执行过**。
  这类失效最阴险：**套件全绿 ≠ 通过，因为根本没跑**。
- ✅ 新增 `scripts/verify-suite-coverage.mjs`（6 项断言）防复发：漏项 / 幽灵项 / 重复项 / 顺序异常 / `bash -n` 语法 + **负向自证**。

  负向验证 5/5 全部按预期判红（删项→红、幽灵名顶替→红、挪出首位→红、制造重复→红、恢复→绿且文件字节一致）。

  > ⚠️ 过程中**我的验证脚本自己撒了一次谎**：用 `String.replace('verify-avatar-asset', …)` 去「制造故障」，但该字符串**第一次出现在注释里**，`replace` 只替了注释、列表没动 —— 于是守护正确地判绿，而我一度以为「守护有漏洞」。
  > **造故障这一步本身也要被验证**（改成只操作 `for` 列表行后，5 项全部如期判红）。

---

## 十四、本次**没有**做的（诚实标注）

- ❌ 没有实测暴力破解（不应对生产站做攻击性测试）；§五 的结论来自**代码核实**：`login.js` 无 Turnstile、无失败计数。
- ❌ 没有跑 Lighthouse 分数（改用真实浏览器 CDP 探针，拿到的是可分解的真实时序，比单一分数更有用）。
- ❌ 没有测移动真机（`perf-probe` 用的是桌面 Edge；移动端结论需要单独跑窄视口 + 真机才作数）。
- ❌ §三 的「约 600ms 收益」是**推算**（658ms 增量 − 404 的 55ms 基线），不是改完后的实测值。改完必须复量。
