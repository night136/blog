# 博客全站优化审查（2026-09-16）

> 起因：用户问「整个还有什么功能可以优化」。
> 本报告只列**有实测证据**的项；纯猜测、无法验证的一律不写。
> 与既有审查的关系：`site-review-2026-09.md`（09-14）的「已知未改」20 项，本报告**逐条核实了当前状态**（见 §七）。
>
> **2026-09-17 更新**：§四（`2733ab4`）、§六 / §九 / §十（`c191a3a`）已落地并线上验证。
> §六 动手时顺带查出一件**与本次改动无关**的旧事（注册框的真实挑战拿不到 token），
> 已用 A/B 排除归因、但**尚未定性** —— 见 §六 末尾，处理顺序表里标 ★。

---

## 一、这次是怎么查的

| 手段 | 脚本 | 拿到什么 |
|---|---|---|
| 线上响应头 / 压缩 / 缓存 | `scripts/audit-live.mjs` | 每类资源的 `content-encoding`、`cache-control`、`etag`、TTFB |
| 爬虫视角复测 | `scripts/audit-spider.mjs` | SSR 正文长度、`<title>`、canonical 条数、`og:image` |
| 真实浏览器冷缓存性能 | `scripts/perf-probe.mjs --cold` | 导航各阶段、FCP/LCP、资源时序、长任务、控制台错误 |
| **对照实验** | 同上，打 `/404.html` | 隔离出「阻塞样式表」的**净代价** |
| 静态代码审查 | — | `functions/` 全部 + `assets/app.js` 关键路径 |

> **真浏览器/线上探针一律入库**（原先只在 `.diag/` 下、不入版本库，报告引用会悬空 —— 别人 clone 下来
> 按报告里的命令跑，得到的是 "No such file"）。现均在 `scripts/`：
>
> | 探针 | 用法 | 测什么 |
> |---|---|---|
> | `audit-live.mjs` | `node scripts/audit-live.mjs [baseUrl]` | 线上响应头 / 压缩 / CDN 缓存 / TTFB（§八、§七 #11） |
> | `audit-spider.mjs` | `node scripts/audit-spider.mjs [slug]` | 爬虫视角 SSR 正文（§爬虫） |
> | `audit-first-paint.mjs` | `node scripts/audit-first-paint.mjs --both [--neg] [--live]` | 真浏览器 A/B：首绘增量 + CLS + 几何指纹（§三） |
> | `audit-a11y.mjs` | `node scripts/audit-a11y.mjs [w] [h] [slug] [local]` | 键盘/焦点/滚动还原（§七 #15 #16 #19 #20） |
> | `audit-csp.mjs` | `node scripts/audit-csp.mjs [--raw-live]` | CSP 三层验收 + 违规收集（§八 CSP） |
>
> ⚠️ 它们**不进 `run-all.sh`**：依赖浏览器或线上网络，作为 CI 判据会很脆弱（名字是 `audit-*` 不是 `verify-*`，`verify-suite-coverage` 不会管它们）。
> 截图/中间产物仍写 `.diag/out/`（gitignore），**只提交脚本、不提交图片**。
> 下文仍会提到少量 `.diag/xxx.mjs`（`cls-shift-diag`、`count-logo-requests`、`turnstile-lazy` 等）——
> 那些是**一次性排查脚本**，它们量出的数都已写进本报告的正文，不构成必读依赖。

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

### ✅ 已修（提交 `d07cd38`）—— 走的是方案 A 的干净版：**构建期内联，源码仍保持外链**

`scripts/lib/inline-css.mjs`（纯函数）+ `build.mjs` 在 `hashAssets()` 之后调用：构建时把
`assets/style.css` 整份换成 `<style data-inlined="style.css">`。**仓库里的 `index.html` 一行没动** ——
它仍是唯一样式来源、仍写着外链，所以「样式只有一份真源、改样式必须改 `assets/style.css`」这条
不变量没被破坏；内联只发生在**构建产物**里。

判据全部按上面「前置验证要求」建成脚本：`scripts/audit-first-paint.mjs`（真浏览器 + 全新 profile +
CDP 限速 + 两侧 br q4 本地服务；移动视口用 `--mobile`）。

| 本机受控对照（CDP 真浏览器、限速 RTT 150ms / 200KBps、两侧都 br q4） | 桌面 1440×900 | 移动 390×844 |
|---|---|---|
| **TTFB→首绘 增量** | 843ms → **425ms**（−418ms） | 853ms → **414ms**（−439ms） |
| `assets/style.css` 请求次数 | 1 → **0** | 1 → **0** |
| 首屏总字节（doc+css） | 48069 → **46066 B** | — |
| 全页布局几何指纹 | `3549702810`（两模式**逐项相同**） | `118277715`（同） |
| 控制台错误 | 0 → 0 | 0 → 0 |

| 线上 A/B（**8 轮 = ABBA×2**；同域名，用 CDP `Fetch` 把**旧形态**顶回去当对照组） | 新形态 | 旧形态 |
|---|---|---|
| TTFB→首绘（各轮 / 均值） | 217, 226, 212, 165 / **205ms** | 1086, 1057, 796, 1056 / **999ms** |
| `assets/style.css` 请求 | 0 | 1（线上真取，br ≈33.6KB） |
| 全页布局几何指纹 | `3658275972`（677 元素 / 9 卡） | `3658275972`（**同**） |
| CLS 各轮 | 0.0541 ×4 | 0.0168 ×3, 0.0541 ×1 |

⇒ **线上省约 794ms**（同一台机器、同一域名，只换「样式表怎么投递」这一件事）。
字节几乎持平：br 后新 **46396 B** vs 旧 **48924 B**（差 2528 B）——
**收益来自少一个跨境往返，不是少传字节**，与上面「体积换算」的预估一致。

（另有一遍 4 轮的：新 163ms vs 旧 983ms、省 819ms —— 两遍结论一致。`--rounds=N` 可加轮次。）

#### 负向自证（证明收益不是「第二次跑更快」这类顺序假象）

`node scripts/audit-first-paint.mjs --both --neg`：在**临时副本**里拆掉内联那一步再跑，
收益当场消失（843 vs 881ms）、5 条断言变红、退出码 1。（`replace` 落空会 `exit 2`，
不会把「没换成」当成「比过了」。）

#### ⚠️ 顺带查出并修掉一个**既有** CLS bug（不是内联引入的，是内联把它暴露了）

首绘提前到 ~425ms 后，暴露出 `.layout { min-height: 100vh }` 的默认 `align-content: stretch`
会把顶栏那一格网格行**拉伸到 93px**，内容到位后再塌回 60px（33px 跳变，CLS +0.0348）。
加 `align-content: start` 修掉，布局指纹与修前完全一致（说明只消除了跳变、没改渲染）。
定位手法：`.diag/cls-shift-diag.mjs` 逐帧布局快照，比对位移前后**谁的高度变了**。

#### ⚠️ 一件**必须说清**的线上副作用：CLS 0.0168 → 0.0541（但仍在 good 区间）

8 轮线上 A/B 里，新形态 CLS **4/4 都是 0.0541**；旧形态 3 轮 0.0168、1 轮 0.0541。
**这不是样式注入引起的重排**，证据有三条：

1. 两形态的**全页布局指纹完全相同**（677 个元素逐项相同）⇒ 渲染结果没变，
   不存在「样式晚到导致重排」—— 而这正是本次判据要防的东西；
2. 位移源已定位到 `assets/app.js:1277`：`loadPosts()` 先往 `cardGrid` 塞 **4 张骨架卡**，
   `fetchAllPosts()` 回来后 `renderCards()` 再换成真实内容（trace 里就是 `card-grid 785x182 → 0x0`）。
   这是**改动前就存在**的重排 —— 旧形态自己也抽到过 0.0541，说明它不是某一形态的属性；
3. 之所以以前大多看不到：旧形态首绘在 ~999ms，骨架→内容的替换通常**落在首绘之前**
   （没画出来的位移浏览器不计分）；现在首绘提前到 ~205ms，这次替换就稳定暴露在用户眼前了。

0.0541 仍在 Core Web Vitals 的 **good 区间（< 0.1）**，而首绘快了约 794ms —— 净收益明确为正。
要彻底消掉它得动 `app.js` 的骨架尺寸（让占位高度贴近真实卡片、或给 `.card-grid` 预留高度），
**那是改视觉/交互的改动，本次没做**（见 §十四）。

#### 配套守护

- `scripts/verify-inline-css.mjs`（20 条，已进 `run-all.sh`）：产物里不得有同源外链样式表、
  内联内容必须与 `assets/style.css` **逐字节相同**、**幂等**（连跑两次不重复内联）、CSS 改了会同步、
  找不到 link 或 CSS 含 `</style>` 时**优雅退化**回外链（宁可慢、不能破页）、源码 `index.html` **必须**保持外链。
  内含负向自证（把 `inlineStyleSheet` 打桩后核心断言必须变红）。
- `verify-asset-versioning.mjs` 两条断言已改写：原来断言「产物里有 `<link href=assets/style.css?v=…`」，
  现在断言「**没有**它、且**有**内联块」。
  ⚠️ 正则只认 `<link … href=` 这种形态：HTML 的**注释里**就写着 `<link rel="stylesheet">` 和
  `assets/style.css`，用松正则会数出「双样式表」这种假故障。
- 源码留痕：`index.html` 那行外链上的注释写明了「源码保持外链 / 由构建期内联 / 🚫 别用
  `media=print onload` / 别删这行」。

⚠️ **两个实现陷阱，将来动这块必看**：
① 内联标记的值**不能带 `assets/` 前缀**（写成 `data-inlined="assets/style.css"` 会被 `hashAssets()`
的版本号正则改写成 `?v=xxxx`，第二次构建就认不出自己写的块，反复内联 / 静默退化）；
② 换掉替换串时**要用函数形式的 `String.replace`**，字符串形式会把 CSS 里的 `$&` 当反向引用吃掉。

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

### ✅ 已修（提交 `c191a3a`）

⚠️ 先更正一处**措辞**：本报告上稿时写的是「首页就加载 Turnstile」。严格说，
改动前它就是「首绘之后才注入」的（`loadTurnstileConfig()` 拿到 Site Key 之后）；
但 `/api/config` 一个 RTT 就回来了，**「首绘之后」并不等于「用不到」** ——
账照样付，只是付得晚一点。所以真正的判据是「**用户没要，就不注入**」，不是「等首绘完」。

做法（`assets/app.js`）：

| 改动 | 内容 |
|---|---|
| `loadTurnstileConfig()` | **只取 Site Key，不渲染** —— 渲染会连锁触发 `ensureTurnstileScript()` |
| 新增 `requireTurnstile(which)` | 唯一出口，只有「留言墙」「注册 tab」两个调用点 |
| `loadGuestbook()` | 只注入脚本不渲染（此刻视图还没 `active`，容器 `display:none`，会被画成 0 宽），渲染仍交给拉完数据后那次 —— 顺带把「先等数据、再串行等脚本」改成两件事**并行** |
| 竞态兜底 | 用户在 `/api/config` 回来之前就点了 → `turnstileNeeded` 记一笔，key 到了补渲染一次；两个 `render*` 相应把容器 `hidden` 复位 |
| 留言墙接口失败 | 也画验证框（否则脚本已就绪 ⇒ 提交路径跳过「等脚本」分支，第一次提交必然弹「人机验证未显示出来」，要多点一次重试） |

实测（`.diag/turnstile-lazy.mjs`，冷缓存 + 真浏览器；本地模式用官方 always-pass 测试 key，
线上模式用真实 site key）：

| 阶段 | 改前 | 改后 |
|---|---|---|
| 首页 | **3 条** `challenges.cloudflare.com` 请求（api.js **28157 B** + 2 个挑战 iframe）、`window.turnstile` 已挂上、两个容器都画了 widget | **0 条**请求、`window.turnstile === undefined`、两个容器全空 |
| 切「留言墙」 | （已提前加载） | api.js 1 次，**token 长度 794**（线上真实 key）✅ |
| 切「注册」 | 渲染一次 + reset 触发新一轮（**4 条** cf 请求） | api.js 1 次，容器渲染正常 ✅（token 见下） |

**负向验证**（两重，都得做）：

- 探针自带 `--neg`：把「无条件 render」写回 `loadTurnstileConfig` → 首页断言如期变红（3 条请求 / 28157 B）；
  且 `--neg` 在**替换落空时会以退出码 2 中止**，不会把「没造出故障」当成「比过了」。
- 守护侧：`verify-first-paint` [9] 旧的「注入点在 /api/config 之后」这条断言**按新设计必然变红**，
  已替换成不变量（`loadTurnstileConfig` 里不许有裸渲染 + 出口唯一 + 启动段窗口不碰注入/渲染），
  并新增**变异⑤⑥**两条自证。全套 19/19 仍全绿。

---

### ⚠️ 顺带查出一件**与本次改动无关**的旧事：注册框的真实挑战拿不到 token

同一次探针里，留言墙拿到了 **794 字符的真 token**，注册框却是 **0**。这必须查清是
「我改坏了」还是「本来就如此」，判据是 **A/B**（`--oldapp`）：

> 不换域名，用 CDP 的 `Fetch.enable` + `fulfillRequest` 把 `assets/app.js` 顶替成
> **旧行为那一份**（启动时无条件 render）—— 因为真实 site key 与 hostname 绑定，
> 本地 `127.0.0.1` 跑会撞 `110200`，所以只能在同一域名下换代码、不换地址。

| 条件 | 留言墙 token | 注册框 token |
|---|---|---|
| 旧行为（启动时无条件 render） | **794** ✅ | **0** ❌ |
| 当前行为（切 tab 时才 render） | **794** ✅ | **0** ❌ |

⇒ **注册框拿不到 token 是既有现象，不是本次改动引入的**。补充证据：
- 本地（官方测试 key）两处都正常出 token（21 字符）⇒ **前端渲染链路是通的**，卡的是真实挑战的判定；
- 注册容器实测 `326×72`、`children=1`、CSS 也没藏（`.auth-turnstile { display:flex; min-height:65px }`）；
- 挑战帧本身在 **closed shadow root** 里，`iframe` 计数永远是 0 —— 所以这里量不到它的几何，
  **不能**据此说「帧没渲染出来」。

⚠️ 这条留在「待单独排查」：它可能只是自动化环境对「弹窗内 widget」的行为差异，
**也可能真的是线上注册流程的问题**（若真拿不到 token，前端会一直拦在「请先完成人机验证」）。
本次没有对它下结论，也没有顺手改 —— 需要一次**人在真机上的手动注册**来定性。

---

## 七、🟡 P2 — 09-14「已知未改」清单：20 项里 **12 项仍在**

逐条核实结果（✅=仍在，⚠️=部分/影响已降低）：

| # | 问题 | 核实 | 影响 |
|---|---|---|---|
| 8 | 登录无失败次数限制 | ✅ 已修（新增 `_lib/loginGuard.js`，见 §十五） | **升 P1**，见 §五 |
| 9 | PBKDF2 10 万次 | ✅ 已修（迭代数写进 hash，渐进升级，见 §十五） | **升 P1**，见 §五 |
| 10 | 阅读量自增非原子 | ✅ 已修（`_lib/views.js` 用 `UPDATE … RETURNING`，见 §十五） | 并发下计数偏差；改 `UPDATE … RETURNING views` 即可 |
| 11 | sitemap / feed / robots 无 `Cache-Control` | ✅ **实测确认**：三者响应头 `cache-control: —` | 每次请求都打 D1 | ✅ `d90db27`。⚠️ 当初那句「加上 `max-age` 即可」**是错的**，见本节末「把这条修错了一次」 |
| 12 | 便签墙 2 次全表聚合 | ✅ 已修（新增 `day` 列 + 覆盖索引，见 §十五） | 函数运算使索引失效，全表扫 |
| 13 | 注册先查重后插入 | ✅ 已修（UNIQUE 冲突返回 409，见 §十五） | 并发冲突时依赖 UNIQUE 兜底，但抛 500 而非 409 |
| 14 | 错误响应格式不统一 | ✅ 仍在 | `{error}` 与 `{ok:false,error}` 混用 |
| 15 | 灯箱无焦点管理 | ✅ 已修（`role=dialog` + 焦点回路 + 正文图可聚焦，见 §十五） | 键盘/读屏用户困在灯箱里 |
| 16 | 无 skip link / `aria-current` | ✅ 已修（skip link + `aria-current="page"` 同步，见 §十五） | 键盘用户要 Tab 过全部导航才能到正文 |
| 17 | `mdToHtml` 把 `# ` 渲染成 `<h2>` | ✅ 仍在 | 影响已降低（SSR 正文能被抓到之后） |
| 18 | 死代码 `gradFor()` | ✅ **确认**：全文件只出现 1 次（定义处），零调用 | 纯卫生 |
| 19 | 顶部 scroll 监听未节流 | ✅ 已修（rAF 节流，实测同任务内 0 次读 `scrollY`，见 §十五） | 每次滚动读 `scrollY` + 2 次 `classList.toggle` |
| 20 | 返回列表不恢复滚动位置 | ✅ 已修（`showView` 统一记录/还原，见 §十五） | 从文章返回首页会跳回顶部（体验明显） |

> 另外 8 项（原 #1~#7 与爬虫正文）已在 09-14/09-15 修掉，本次复测确认有效。

### ⚠️ 把 #11 修错了一次（2026-09-17，值得单独记）

第一版按上面那句「加上 `max-age` 即可」做的：给三个端点加了
`Cache-Control: public, max-age=300, s-maxage=1800, swr=86400`，上线后头都在、
判据全绿。**但边缘根本没缓存** —— 也就是说 D1 压力一点没减，只是「看起来修好了」。

一次性探针（`/api/_probe-a`，与 `/api/posts/meta` 同 Content-Type、同 `s-maxage`，
唯一差别是没用 Cache API）实测：

| 端点 | Cache API | `s-maxage` | 实测 |
|---|---|---|---|
| `/api/posts/meta` | ✅ | ✅ | `cf-cache-status: HIT`（age 15→25→33 递增） |
| `/api/_probe-a/b/c/d` | ❌ | ✅ | **连 `cf-cache-status` 都不出现** |

⇒ 根因**不是** Content-Type、也**不是** SWR（这两组变量都单独隔离过），而是
**Pages Functions 的响应不会因 `s-maxage` 自动进 CDN 缓存，必须用 Cache API 显式写**。
仓库里其实早写着这句 —— `functions/api/posts.js:58`：

> `// 边缘缓存：Pages Functions 不会因 s-maxage 标头自动走 CDN 缓存，必须用 Cache API 显式存边缘。`

**教训**：判据必须是**目标本身**，不能是它的代理指标。
「响应里有 `Cache-Control`」是代理指标，「命中缓存时不打 D1」才是目标 ——
后者能一眼看穿这个错。现在守护里的判据就是后者：
把 D1 换成**必炸**的实现，只要缓存还能正常返回，就证明它压根没走到 D1。
（这与 `verify-first-paint` 当初写死「注入点在 /api/config 之后」是同一类错误：
**盯不变量，别盯代理指标**。）

---

## 八、🟡 P2 — 安全响应头有缺口，且 `functions/` 完全裸奔 —— ✅ 已修（`d90db27` + 本批补齐 CSP）

> 收口见 `docs/security-headers.md`。守护 `scripts/verify-security-headers.mjs`（74 项，含 4 项负向自证）。

### 实测（`audit-live.mjs`）

| 响应头 | 静态资源 | `functions/` 生成的响应（`/api/*`、`/sitemap.xml`、`/feed.xml`、`/robots.txt`） |
|---|---|---|
| `referrer-policy` | ✅ | ❌ → **已补** |
| `x-content-type-options` | ✅ | ❌ → **已补** |
| `content-security-policy` | ❌ → **已补** | ❌ → **已补**（只上了不需要 nonce 的那半） |
| `strict-transport-security` | ❌ → **已补** | ❌ → **已补** |
| `x-frame-options` / `frame-ancestors` | ❌ → **已补** | ❌ → **已补** |
| `permissions-policy` | ❌ → **已补** | ❌ → **已补** |

**根因**：`_headers` 只对**静态文件**生效，Functions 返回的响应不经过它。所以 `/api/*` 与三个 XML/TXT 端点连基础的 `nosniff` 都没有。

### 修法（实际落地）

- `functions/_lib/security.js` —— 6 个头的**唯一来源**。
- `functions/_middleware.js` —— 放在 `functions/` 根，给**所有**函数响应兜一层。
  ⚠️ 用 `onRequest` 而非 `onRequestGet`（写接口全是 POST/DELETE，否则漏掉一半）。
  ⚠️ 这一层**只加不删**：只 `set()` 那 6 个头，绝不碰 `cache-control` / `content-type` / `set-cookie`。
  （静态资源的缓存策略来自 `_headers`，被这一层改写就是全站缓存策略崩掉；`set-cookie` 一丢，登录就静默失效。）
- `_headers` 全局块同步补上 HSTS / XFO / Permissions-Policy / CSP。

**CSP 只上了不需要 nonce 的那一半**：`object-src 'none'; base-uri 'self'; frame-ancestors 'none'`
（依据：全仓 0 个 `<object>` / `<base>` / `<iframe>`，真 grep 过）。
`script-src` / `style-src` **仍然没上** —— 页面有 3 段内联 `<script>`，
`build.mjs` 还会把整张 `style.css` 内联进 `<head>`，直接上会当场白屏；要上得先给它们算 hash/nonce，
**另立一项**。

### 两个值得单独记的取舍

1. **HSTS 不带 `includeSubDomains`**：`pages.dev` 是所有 Cloudflare Pages 项目共用的域，
   加了等于替别人的项目做主。更不带 `preload`（要提交进浏览器预加载列表，撤不回来）。
2. **`Permissions-Policy` 刻意不列 `clipboard-write` / `web-share`**：
   站内「复制链接」用 `navigator.clipboard`（`app.js:682`）、「分享」用 `navigator.share`（:824），
   写进 `()` 等于亲手把这两个按钮弄坏。守护里有一条**反查**：
   从 `app.js` 数出站点真在用的能力，再断言头里没禁它们。

### 线上验收（`audit-live.mjs`，12 条判据，退出码 0）

改动前基线 `.diag/audit-before.txt`：7 条「不许回归」全绿、5 条「应该修好」全红、exit 1。
改完 `.diag/audit-after.txt`：全绿、exit 0。

其中三条最值得留意：

- **函数响应全都有 6 个安全头** —— 离线的假 context 证明不了运行时接线，只有线上能证明根中间件真挂上了。
- **静态资源的 `Cache-Control` 逐字未变** —— 本次最大回归风险就在这里。
- **`/api/logout` 的 `Set-Cookie` 还在** —— 不需要登录态就能端到端验证中间件没把 cookie 吃掉。

⚠️ 另加一条**负向对照**：拿不存在的 slug 探爬虫注入必须**不**注入。因为外壳
`index.html:378` 本来就写着空的 `<!--SSR-BODY-START--><!--SSR-BODY-END-->` 占位 ——
没有这条对照，「正文块存在」可能只是匹配到占位（**本次验收就踩过这个假结论**，
旧脚本用 `([\s\S]*?)` 允许空匹配 + 拿 `hello-world` 这种不存在的 slug 去探）。

⚠️ **部署传播不是瞬时的**：改完 `_headers` 刚部署的几十秒内可能撞上还没换新的边缘副本
（签名：刚好缺新加的 4 个、却带着原本的 2 个）。第一次跑线上验收就踩了，
隔一分钟同一批 URL 再探就齐了。脚本已会识别这个签名并提示，免得误判成配置写错。

---

## 九、🟡 P2 — 仓库卫生

| 项 | 体积 | 状态 | 建议 |
|---|---|---|---|
| `assets/uploads/微信图片_20260519215702.jpg` | 233 KB | ✅ **已删**（`c191a3a`） | 删前先证伪了「被 D1 的 cover 字段引用」：线上 16 篇文章的 `cover` 全是 `/generated/body-images/*`，且把 16 篇正文逐篇拉回来 grep `uploads` → **命中 0** |
| `replace_logo.py`（根目录） | 5.2 KB | ✅ **已删**（`c191a3a`） | 一次性脚本，已被 `scripts/build-avatar-asset.py` 取代 |
| `assets/logo-avatar.png` | 24 KB | 与 `logo-hero.png` **内容相同** | 见 §四 |
| `content/posts/*.md` | 5 个 + `index.json` | 迁移前备份（README 写「可留可删」） | 留着当离线备份或移出仓库 |
| `outputs/` | — | ✅ 已在 `.gitignore` | 无需处理 |
| `scripts/fixtures/`、`scripts/lib/` | — | ✅ **有用的**（农历黄金样本、SEO 渲染/摘要库） | **不要删** |

> 删完的验证：`?cb=<随机>` 强制回源 → `assets/uploads/微信图片_20260519215702.jpg` **404**。
> （不带 cb 时仍 200 —— 那是 `/assets/*` 的 `max-age=86400 + swr=604800` 边缘缓存，
> **不是**「没删掉」。这个区分不做，就会得出相反结论。）

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

### ✅ 已修（提交 `c191a3a`）

- 字体那段改成开门见山：**「这里指的是上面这套字体的样式表」**，并明确写「🚫 它**不是**在说 `assets/style.css`」，
  顺手把「曾被读混过一次、差点去修一个本来正确的东西」也记在注释里；
- `assets/style.css` 那行旁边改成 **「**故意阻塞加载** —— 这不是漏改、也不是过时代码，🚫 别顺手改成 `media="print" onload`」**，
  并补上代价数字（658ms vs 55ms）与「要动先建 FCP/CLS 判据」。

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

| 顺序 | 项 | 收益 | 风险 | 状态 |
|---|---|---|---|---|
| 1 | §四 重复 logo 合并 | 首屏 −24.8KB、−1 请求 | 极低 | ✅ `2733ab4` |
| 4 | §六 Turnstile 改按需 | 首页**不再付** 3 个跨境请求 / 28KB | 低 | ✅ `c191a3a` |
| 8 | §九 仓库卫生 + §十 文档债 | 长期可维护性 | 极低 | ✅ `c191a3a` |
| 2 | §五 登录加固（Turnstile + 失败计数 + PBKDF2 渐进升级） | 堵住唯一裸奔入口 | 低 | ✅ 本批（见 §十五）。⚠️ 三件里 PBKDF2 那件是**把迭代数写进 hash**，不是直接改常量 —— 直接改会锁死所有现存密码 |
| 3 | §三 style.css 不再阻塞 | 首绘 **−418ms**（桌面）/ **−439ms**（移动）；线上 A/B **−794ms** | 中 | ✅ `d07cd38`。判据（增量 + CLS + 几何指纹）已沉淀成 `scripts/audit-first-paint.mjs`，负向自证已跑 |
| 5 | §八 安全头统一 + §七 #11 缓存头 | 安全基线 + 三个端点不再每次打 D1 | 低 | ✅ `d90db27`。⚠️ #11 第一版按「加 max-age 即可」做，**是错的**（边缘不缓存 Functions），已改用 Cache API 重做（见 §七 末）。线上 12 条判据全绿 |
| 5b | §八 剩下的那一半 CSP（`script-src` / `style-src`） | 真正的 XSS 收窄 | 中 | ✅ 本批（见 §十五）。⚠️ 原判「要给 **3** 段内联 `<script>` + `style.css` 算 hash」**不准确**：实际只有 **1** 段内联 `<script>`，而 `style.css` 那一侧哈希**做不到**（构建期生成 + 19 处 style 属性），只做了来源白名单 |
| 6 | §七 #10 #12 #13 | 数据层正确性 | 低 | ✅ 本批（见 §十五） |
| 7 | §七 #15 #16 #19 #20 | a11y / 体验 | 低 | ✅ 本批（见 §十五） |
| ★ | **§六 顺带查出的「注册框真实挑战拿不到 token」** | 可能是线上注册流程的问题 | — | **待定性**（需一次真机手动注册），见 §六 末尾 |

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
- ⚠️ §三 当初那句「约 600ms 收益」是**推算**（658ms 增量 − 404 的 55ms 基线），不是实测。改完已复量：
  **−418ms（桌面）/ −439ms（移动）**（本机受控）+ **−794ms**（线上 A/B，8 轮）。留这段是为了记住口径 ——
  **推算可以当立项理由，不能当结论**。
- ❌ §三 暴露出的那个骨架屏重排（`app.js:1277`「4 张骨架卡 → 真实内容」）**没有修** ——
  它会把线上 CLS 抬到 0.0541（仍在 good 区间），但修它要动占位卡的高度/数量，属于**视觉改动**，
  需要单独确认后再做。
- ❌ 全程**没有**在真机上手动完成一次注册。所以 §六 末尾那件「注册框真实挑战 token 为 0」
  只用 A/B 排除了「本次改动引入」，**没有定性**到底是自动化环境的差异还是线上真有问题 ——
  要定性只能靠一次真人手动注册。

---

## 十五、2026-09-17 第二批：§五 + §七 #10/#12/#13 + a11y 四项 + CSP 下半

四块一起做完。下面只记**实测出来的数**与**踩到的坑** —— 每条都配了守护，且守护本身都做了负向自证
（详见各 `scripts/verify-*.mjs`；真浏览器探针在 `scripts/audit-a11y.mjs`、`scripts/audit-csp.mjs`）。

### 15.1 §五 登录加固（commit 见 `git log`）

| 件 | 做法 | 关键约束 |
|---|---|---|
| 人机验证 | `/api/login` 前置 `verifyTurnstile`，未配 `TURNSTILE_SECRET_KEY` 时放行（与 register 同款） | 放在**最前**：脚本连一次 PBKDF2 的 CPU 都花不到我们身上 |
| 失败计数 | 新表 `login_attempts`（`scripts/migrate-login-attempts.sql`）+ `_lib/loginGuard.js`：15 分钟窗口内按**用户名**与**IP**两维计数，取较大者；≥5 次开始 **递增延迟** `min(400·2^(n−5), 5000)ms` | 🚫 **不做硬锁**：硬锁是给攻击者一把 DoS 真实用户的杠杆。计数刻意做在**查用户之前**，对存在/不存在的用户名一视同仁，否则它自己会变成新的枚举信号 |
| PBKDF2 渐进升级 | 迭代数**写进 hash**：`pbkdf2$<iter>$<salt>$<hash>`；老的 `salt:hash` 按 100000 校验；校验通过后顺手用新迭代数重写 | 🚫 绝不能直接改常量（会锁死全部现存密码）。⚠️ 连**假哈希**也必须用同一个 `targetIterations(env)` —— 用老格式的假哈希会让"用户不存在"明显更快，把时序侧信道又打开 |

- 守护 `scripts/verify-login-hardening.mjs`：**93 项**，含老格式密码端到端登录、UNIQUE→409、假哈希同源（负向自证：写死成字面量必须判红）。
- ⚠️ **顺手改掉一个错判**：`verify-no-tdz.mjs` 原有一条「假哈希必须是 `salt:hash` 格式」——
  哈希格式一升级它就变红，而代码完全正确。这是**拿代理指标当判据**，已改成"假哈希与真密码的迭代数同源"并配负向自证。

### 15.2 §七 #10 / #12 / #13 数据层

- **#10 阅读量原子自增**：新增 `_lib/views.js`，`UPDATE posts SET views = COALESCE(views,0)+1 WHERE slug=? RETURNING views`（读后写一次完成）。
  降级路径：`no such column: views` → `{views:null}`；其它错误 → `UPDATE`+`SELECT` 并**留日志**（`X-Views-Atomic: 0` 供线上区分是否走到降级）。
- **#12 便签墙连击聚合**：新增 `day` 列（`scripts/migrate-guestbook-day.sql`）+ `idx_guestbook_day(day DESC)`，
  聚合从 `DISTINCT substr(created_at,1,10)` 改为直接读 `day`。
  **实测（真 `node:sqlite` 跑 `EXPLAIN QUERY PLAN`）**：老写法建 **2 个 TEMP B-TREE**，新写法是**覆盖索引扫描**。
- **#13 注册并发冲突**：INSERT 撞 UNIQUE → 返回 **409**（原来 500）；错误文案不再回显 `e.message`。
- ⚠️ **两种「列不存在」的报错文案不同**：SELECT 是 `no such column: day`，INSERT 是 `table X has no column named day`。
  降级判断只匹配前者的话，**写操作会 500**（第一版就是这样，被 `verify-data-layer.mjs` 抓到）。
- 守护 `scripts/verify-data-layer.mjs`：**28 项**，用真 SQLite（`--experimental-sqlite`，脚本自己带 flag 重入）跑并发语义、降级、以及"缺列时便签墙 GET/POST 不得 500"。

### 15.3 §七 a11y 四项

| # | 做法 | 真浏览器实测（`scripts/audit-a11y.mjs`，1200×900 与 390×844 **各 27/27**） |
|---|---|---|
| 15 灯箱 | `role="dialog" aria-modal="true" aria-label`；打开时焦点移入关闭按钮、Tab/Shift+Tab 回卷、关闭时还给触发图 | 连按 8 次 Tab 逃逸 **0** 次；Escape 与点遮罩两条关闭路径焦点都回到那张 `<img>` |
| 16 skip link | `<body>` 里第一个可聚焦元素；落点 `<main id="main-content" tabindex="-1">`；`aria-current="page"` 与 `.active` 同源同步 | 按 1 次 Tab 就落在 skip link（且真的滑进视口）；回车后焦点到 `#main-content`，下一个 Tab 仍在正文内 |
| 19 滚动节流 | rAF 节流：本帧已排队即返回；`{passive:true}`；注册后同步首跑一次 | 10 次同步 scroll 事件在同一任务内读 `scrollY` **0** 次（对照组未节流写法读 **10** 次，证明量法不是恒 0） |
| 20 返回列表 | `showView` 统一记录/还原 `scrollY`；`viewIndex`→`Object.create(null)`；文章视图永不还原 | 滚到 1400 → 打开文章（0）→ 返回 **1400**；切归档再切回 **1400**；第二篇文章仍从 0 开始 |

- 🔴 **真浏览器抓出一个静态断言看不见的 bug**：还原那一句原写 `behavior:"auto"` —— 而 `auto` 的语义是**听 CSS**，
  `style.css:82` 给 `html` 设了 `scroll-behavior:smooth`，于是"回到原处"变成一段横跨整个列表的滚动动画
  （同一帧读回 `scrollY` 只有 **2**）。已改 `behavior:"instant"`，并把这个不变量钉进 `verify-a11y.mjs`。
- ⚠️ **灯箱是"点击正文图"触发的，而 `<img>` 本来不可聚焦** ⇒ 纯键盘用户永远打不开它，前面三条全白做。
  已给**带 alt** 的正文图加 `tabindex="0" aria-haspopup="dialog"`（alt 为空表示装饰图，不加 Tab 停靠点），
  并在 `postDetail` 上补 Enter/空格 的键盘等价操作。⚠️ 这段模板必须与 `scripts/lib/seo-render.mjs` **逐字一致**
  （`verify-seo-render.mjs` [12] 逐条比对两边输出）。
- 守护 `scripts/verify-a11y.mjs`：**34 项**（22 条判据 + 9 条负向自证），已加入 `run-all.sh`。

### 15.4 §八 CSP 下半（`script-src` / `style-src`）

最终值（`_headers` 与 `functions/_lib/security.js` 两份拷贝，守护逐字比对）：

```
script-src 'self' 'sha256-CJjlP287d9o8os05q1pTscyxju+Buc5X14AenQ46bUY=' https://challenges.cloudflare.com;
style-src  'self' 'unsafe-inline' https://fonts.font.im
```

- **两边走的两条路，是因为哈希在一侧真的做不到**：
  - `script-src` 用**哈希**（严格）：全站只有 **1 段**内联 `<script>`，它是源码里的静态文本、构建期不碰 ⇒ 哈希是稳定常量。
    ⚠️ 审计原文写的「3 段内联 `<script>`」**不准确**（把注释里提到的那些也数进去了）。
  - `style-src` 只能是**来源白名单 + `'unsafe-inline'`**：`index.html` 有 **19 处** `style="…"` 属性（运行期还有大量 `el.style.x=…`），
    而构建期还会把整张 `style.css` 内联成 `<style data-inlined>` —— 后者的哈希**随每次改样式而变**，写死在头里必然过期。
    这一条的价值是**收窄来源**（挡住任意外域样式表 / `@import` 外链），不是挡住内联样式。删掉 `'unsafe-inline'` 是白屏，不是加固。
- 🔴 **哈希必须按 LF 计算**：仓库 `core.autocrlf=true` ⇒ 工作区 CRLF、线上 LF。
  实测同一段脚本：LF 版 `sha256-CJjlP287…`（4834 字符），CRLF 版 `sha256-i6C6OEYy…`（差 79 个 `\r`）。
  在 CRLF 上算出来的哈希，线上就是**整段启动脚本被拒 ⇒ 白屏**。
- 🔴 **内联事件处理器不在哈希覆盖范围内**：兜底横幅那两个按钮原本是 `onclick="…"`，
  加了 `script-src` 之后会被拦掉 —— 而那恰好是"站点已经启动失败、只剩这个横幅能自救"的时刻。
  已改成 `addEventListener`（绑在那段有哈希白名单的内联脚本里）。`verify-security-headers.mjs` 现在断言「标记里没有内联事件处理器」。
- ⚠️ 断言前要**剥两层注释**：HTML 注释里会**提到** `<script>` 与 `onclick`（解释为什么不能用），
  `<script>` 块里的 JS 注释也一样。第一版只剥了 HTML 注释，于是被自己写的解释注释判红（假故障）。
- **验收链路（三层，`scripts/audit-csp.mjs`，17/17）**：
  1. `[A]` 本地服务直接吐仓库里的 CSP ⇒ 页面正常启动、零违规、19 处内联 style 仍生效、兜底按钮无 `onclick`；
  2. `[B0]` **负向对照**：拿线上此刻的旧 HTML 配新哈希 ⇒ 浏览器**确实**报 `script-src-elem` 违规，
     并在控制台把**正确的哈希念出来**（这条比"断言失败"有用：修复线索不需要人肉猜）；
  3. `[B]` 线上**真域名** + 新 CSP + 新版内联脚本 ⇒ 零违规、浏览器自算哈希与 CSP 一致、
     Turnstile 的 `api.js` 仍被放行（`window.turnstile` 存在、挑战组件仍能挂载）。
- ⚠️ **Turnstile token 为 0 的 A/B**：headless 下拿不到 token。为分清"是不是 CSP 干的"，跑了对照组 ——
  **同 HTML + 线上现有 CSP 同样拿不到**（容器 661×72 已渲染）。⇒ 与本次 CSP 改动**无关**（沿用 §六 末尾那条未定性的旧账）。
- `verify-inline-css.mjs` 新增一条**闭环**断言：**构建产物**里那段内联脚本的哈希也必须命中 CSP 白名单 ——
  否则"源码对、CSP 对、构建动了字节"这种情况没人管（而且它也是第一版误红的地方，正好证明了这条的价值）。

### 15.5 顺手修掉的两条**守护自身的错判**（都属"拿代理指标当判据"）

| 守护 | 原判据 | 为什么会误红 | 现在的判据 |
|---|---|---|---|
| `verify-mobile-guards.mjs` | `/function showView[\s\S]{0,1200}?\n  \}/` | `showView` 加了 #20 的滚动还原后自然变长 > 1200 字符 ⇒ 报「未找到 showView」 | 改成**花括号配对**取函数体，不设长度上限 |
| `verify-contrast-tokens.mjs` | 「按 `tabIndex >= 0` 过滤的候选集**恰好 2 处**」 | 加了第 3 个候选集（`lightboxFocusables`）⇒ 误红，而新候选集**确实**带了这道过滤 | 枚举所有 `*Focusables()` 逐个体检，将来的第 4 个自动被覆盖 |

> 两次都是同一种病：**把"当时有几个/有多长"写进判据**。判据要盯**目标**（这件事还能不能发生），
> 不是盯实现形态。`verify-no-tdz` 那条假哈希格式断言是第三次。
