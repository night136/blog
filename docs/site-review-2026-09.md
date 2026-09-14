# 博客全站审查报告（2026-09-14）

对 `blog-site` 做了一轮全站审查（前端 `assets/app.js` 2371 行 / 后端 `functions/**` 22 个文件 / 样式 1541 行），
逐条实测确认，**不采信「理论上有问题」的推测**。以下按真实严重程度排列。

---

## 一、P0 — 线上正在发生的故障（已修复）

### 1. 打开任何文章都失败：`openPost` 的 TDZ（暂时性死区）★ 最重要

**症状**：打开任意文章，正文区显示「文章加载失败，请重试」，**控制台没有任何报错**。
该故障自评论点赞功能（commit `dd782fa`）引入，已在线上存活数周。

**根因**：

```js
// app.js  ≈446 行
async function openPost(slug) {
  try {
    ...
    currentSlug = slug;        // ← 写入（第 497 行）
    currentPost = post;
    currentPostAuthor = post.author;
    ...
  } catch (_) { postDetail.innerHTML = `...文章加载失败，请重试...`; }   // ← 异常被静默吞掉
}

// app.js  ≈1858 行（文件后半段）
let currentPostAuthor = "";    // ← 声明
let currentSlug = "";
let currentPost = null;
```

函数体内的赋值写在变量 `let` 声明**之前** → 求值时落入 TDZ → 抛 `ReferenceError`。
因为异常发生在 `try` 块里、且 `catch (_)` 完全丢弃了错误对象，
**用户只看到失败文案，开发者看不到任何错误**，所以长期无人发现。

**为什么之前没被抓到**：`scripts/smoke-app.mjs` 只执行 app.js 顶层同步路径，
不调用 `openPost`，因此碰不到这个函数体内的 TDZ。历史上修过一次同类问题，
但只修了 `currentUser` 一个变量（注释还写着「避免 TDZ」），同组另外 6 个全部遗漏。

**影响面**：`currentSlug` / `currentPost` / `currentPostAuthor` / `editingSlug` / `commentSort` / `replyTo`
六个变量在 1858 行之后才声明，却在 478~1051 行之间被大量使用 —— 文章详情、
点赞、评论排序、回复、编辑，**整条交互链全部失效**。

**修法**：把 7 个状态变量（含 `currentUser`）统一提升到 IIFE 顶部集中声明，
原位置只留注释说明「为何必须放在顶部」。

**验证**：用 vm 沙箱注入真实字段结构的数据后调用 `openPost`，
`postDetail.innerHTML` 由失败文案的 **49 字符** → 完整文章 HTML 的 **1794 字符**。

### 2. `openPost` 无请求竞态保护

四处 `await`（静态快照 / 动态接口 / 会话 / 阅读数）之间没有失效判断。
快速连点两篇文章时，先发的请求可能后返回，把后发请求已渲染的正文覆盖掉，
出现「标题是 A、正文是 B」；`currentSlug` 也会被旧值覆盖，导致点赞打到错误的文章上。

**修法**：引入自增序号 `openSeq`，进入时 `const seq = ++openSeq`，
每个 `await` 之后 `if (stale()) return;`（共 5 处）。

### 3. `initReadingProgress` 事件监听泄漏

每次打开文章都 `window.addEventListener("scroll", update)`，但**从不移除**。
读 N 篇文章后，滚动一次会触发 N 个 handler，且旧闭包持有已卸载的 `.post-body`
引用，每次滚动都做无用的 `getBoundingClientRect` + `offsetHeight`（强制重排）。

**修法**：用 `progressHandler` 保存引用，绑定前先 `removeEventListener`。

---

## 二、P1 — 真实缺陷（已修复）

### 4. 便签墙边缘缓存「串号」（登录态被串到匿名用户）

`functions/api/guestbook.js` 的缓存键只取 `request.url`，但响应体里含
`canDelete` 与 `currentUser` —— 这两个值**随登录态变化**。
站长先访问 → 把 `canDelete: true` 缓存 30s → 随后所有匿名访客命中同一份缓存，
**人人看到删除按钮**。（越权删除仍被 `manage.js` 拦截，属 UI 泄露而非提权。）

**修法**：缓存键追加登录态维度 `_u=<username|->`。

### 5. 登录接口泄露「用户名是否存在」+ 无时序防护

```js
if (!user) return json({ error: "用户不存在" }, 401);
const ok = await verifyPassword(...);
if (!ok) return json({ error: "密码错误" }, 401);
```

两条文案可区分 → 可枚举出哪些用户名/邮箱已注册。且用户不存在时**直接返回**，
跳过了 10 万次 PBKDF2，响应耗时差异明显（可作时序侧信道）。

**修法**：统一文案「用户名或密码错误」；用户不存在时也走一次**格式合法**的假哈希校验。

> ⚠️ 踩坑记录：第一版假哈希写成 `"pbkdf2$100000$...$..."`，
> 但 `verifyPassword` 期望的格式是 `salt:hash`（冒号分隔），
> 无冒号会命中 `indexOf(":") < 0` 直接 `return false` —— **跳过了 PBKDF2，反而制造出时序差异**。
> 改为带冒号的 `"AAA...:AAA..."` 后实测两种分支耗时 **27.2ms vs 27.3ms（比值 1.00）**；
> 无冒号版本仅 **0.00ms**。这条已写成守护断言。

同时修掉 `catch` 分支回显 `e.message`（会泄露表结构 / SQL 细节），改为记录到服务端日志。

### 6. 搜索无结果上限，全表返回大体积正文

`LIKE '%kw%'` 天然无法走索引（必然全表扫描），且 `SELECT` 含 `body`
（正文里有 base64 内联图）。原先没有 `LIMIT`，文章一多即慢查询 + 响应体积失控。

**修法**：加 `LIMIT 60`（`body` 保留 —— 详情页要用它算 readingTime 与字数）。

### 7. 键盘用户看不到焦点位置（a11y 最大缺口）

站内 `.card` / `.nav-link` / `.chip` / `.share-item` / `.comment-like` 等大量可点元素
**没有任何可见的聚焦样式**，纯键盘用户无法判断自己在页面的哪个位置。
（输入框类已有 `box-shadow` 兜底，问题在其余可点元素。）

**修法**：文件末尾追加全局 `:focus-visible` 规则 —— 用 `:focus-visible` 而非 `:focus`，
只在**键盘**导航时出现轮廓，鼠标点击不触发，不影响现有观感。

---

## 三、已知但本次未改（供后续决策）

| # | 问题 | 说明 |
|---|---|---|
| 8 | 登录无失败次数限制 | 可无限暴力破解。建议按 IP + 用户名做失败计数与递增延迟 |
| 9 | PBKDF2 迭代 10 万次 | 低于 OWASP 当前建议（60 万）。改动会让现有密码无法校验，需迁移方案 |
| 10 | 阅读量自增非原子 | `UPDATE ... SET views = views + 1` 后回读，并发下计数偏差；可改 `UPDATE ... RETURNING views` |
| 11 | `sitemap.xml` / `feed.xml` / `robots.txt` 无 `Cache-Control` | 每次请求都打 D1 |
| 12 | 便签墙每次列表请求做 2 次全表聚合 | `COUNT(*)` + 对 `created_at` 做 `substr` 的 `DISTINCT`（函数运算导致索引失效） |
| 13 | 注册先查重后插入（非原子） | 并发下依赖 UNIQUE 约束兜底，但冲突时抛原始 SQL 错误返回 500 而非 409 |
| 14 | 错误响应格式不统一 | `{error}` 与 `{ok:false, error}` 混用 |
| 15 | 灯箱无焦点管理 | 无 `role="dialog"`、不开/关不转移焦点；可复用分享面板已有的焦点保存/归还实现 |
| 16 | 无 skip link / `aria-current` | 键盘用户需 Tab 过全部导航才能到正文 |
| 17 | `mdToHtml` 把 `# ` 渲染成 `<h2>` | 页面存在多个 `h2` 而无对应 `h1`，语义层级断裂 |
| 18 | 少量死代码 / 调试残留 | `gradFor()` 定义后从未调用；若干 `console.error` |
| 19 | 顶部 scroll 监听未节流 | 每次滚动都读 `scrollY` 并两次 `classList.toggle` |
| 20 | 返回列表不恢复滚动位置 | 从文章返回首页会跳回顶部 |

---

## 四、守护与验证

新增 `scripts/verify-no-tdz.mjs`（**24 项**，已纳入 `run-all.sh` 首位，跑得最快先兜底）。

与其他 verify 脚本不同，它不是文本匹配，而是**作用域感知的静态分析**：

1. 计算每行花括号净深度（先剔除注释，避免 `{}` 干扰计数），识别「IIFE 顶层」语句；
2. 收集顶层全部 `let/const` 声明及行号（本次识别出 106 个）；
3. 找出所有函数体（181 个），定位「引用了顶层变量、但引用行号 < 声明行号」的位置；
4. 排除该函数内被重新声明 / 作为参数 / 解构 / `for` 绑定 / `catch` 捕获的名字（那是本地变量，不是 TDZ）；
5. 排除 `typeof x`（对 TDZ 安全）。

另含：关键变量必须声明在文件前 1/3、无重复 `let`、`openPost` 竞态结构、
监听清理、后端三项安全、`:focus-visible` 存在性等断言。

**负向验证 8/8 全部拦住**（含「把 `currentSlug` 挪回文件后半段」这一精确重现原始事故的场景）：

| 篡改场景 | 结果 |
|---|---|
| `currentSlug` 挪回文件后半段（重现原事故） | ✅ 拦住 |
| `currentPost` 挪回文件后半段 | ✅ 拦住 |
| 去掉 `openSeq` 竞态保护 | ✅ 拦住 |
| 去掉阅读进度监听的旧监听清理 | ✅ 拦住 |
| 登录恢复泄露「用户不存在」 | ✅ 拦住 |
| 去掉便签墙缓存键的登录态维度 | ✅ 拦住 |
| 去掉搜索的 `LIMIT` 上限 | ✅ 拦住 |
| 去掉全局 `:focus-visible` | ✅ 拦住 |

> ⚠️ 另一处踩坑：首版断言直接在全文件搜「用户不存在」，
> 结果**被我自己写的解释性注释命中**而误报失败。已改为先剥注释再断言 ——
> 凡「断言某个字符串不存在」的检查，都要先排除注释。

**全量回归**：`no-tdz 24 / og 40 / xss 23 / jwt 18 / manage / cover 35 / asset 14 /
frontend 15 / mobile 65 / share 63 / lunar 9 / smoke` —— **3 秒全绿**。

---

## 五、最值得记住的一条

`catch (_) { ... }` 这种**丢弃错误对象**的写法是这次故障长期潜伏的直接原因：
真正的错误信息（`ReferenceError: Cannot access 'currentSlug' before initialization`）
被完整吞掉，只留下一个用户可见的、无信息量的失败提示。

**约定**：catch 至少要把错误记下来（`console.error`），
并且在 catch 里返回给用户的文案不应包含内部异常细节 ——
这两件事不矛盾：**详细记日志、模糊给用户**。
