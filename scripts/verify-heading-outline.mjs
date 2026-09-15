// 标题层级守护：一页只能有一个 h1，而且必须是「这一页的主题」。
// 用法：node scripts/verify-heading-outline.mjs
//
// 背景（2026-09-15 梳理）：本站是 SPA，所有视图同时存在于同一个 HTML 里，
// 于是 h1 该落在谁头上这件事被三个地方同时绑架，牵一发动全身：
//
//   ① 侧边栏的站点名原本是 <h1>昉昕</h1>，而侧边栏挂在**每一个**视图上 ——
//      文章页因此有两个 h1（站点名 + 文章标题），搜索引擎判定主题时会跟着摇摆。
//      站点名是「站点身份」，不是「本页主题」，降级成无语义容器 .brand-name。
//   ② 文章正文的标题从 `## ` 起步、映射到 h2；文章标题自己也是 h2 —— 两者同级，
//      等于「章节」和「文章」一样大。文章标题改 h1 后，正文的 `# ` / `## ` 落 h2 刚好接得上。
//   ③ `.post-detail h2` 是**后代**选择器，会连带命中 .post-body 里的正文 h2，
//      把标题的字号/字距/margin 泄漏到正文小标题上；从前只靠 .post-body h2 恰好写在源码后面
//      才盖回去，样式顺序一调整就翻车。现在锁定为直接子元素 `.post-detail > h1`。
//
// 所以本脚本盯的不是「某个标签写没写对」，而是这三处的**一致性**：
// 前端渲染 / 构建期爬虫片段 / 样式选择器，任何一处单独改回去都会在这里变红。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildArticleHtml, renderMarkdown } from "./lib/seo-render.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const HTML_SRC = fs.readFileSync(path.join(root, "index.html"), "utf8");
const APP_SRC = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
const CSS_SRC = fs.readFileSync(path.join(root, "assets", "style.css"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}

// ── 先剥注释再做匹配 ────────────────────────────────────────────
// 这不是洁癖：本文件要断言「CSS 里不再存在 .post-detail h2 这个后代选择器」，
// 而 style.css 的注释里恰恰写着「旧的 .post-detail h2 会泄漏」——
// 不剥注释，这条断言永远为真（假通过）。
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, "");
const stripScripts = (s) => s.replace(/<script[\s\S]*?<\/script>/gi, "");
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
// CSS 只剥块注释：文件里有 url('http://www.w3.org/2000/svg')，按 // 剥行注释会把它劈坏。

const HTML = stripScripts(stripHtmlComments(HTML_SRC));
const CSS = stripCssComments(CSS_SRC);

// ── 可复用的检测函数（正文里会拿「改回旧写法」的样本再喂一遍做负向验证）──
const h1sIn = (s) => [...String(s).matchAll(/<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>/gi)]
  .map((m) => m[1].replace(/<[^>]+>/g, "").trim());
const brandIsH1 = (html) => /<h1[^>]*>\s*昉昕\s*<\/h1>/.test(html);
const widgetLevels = (html) => [...String(html).matchAll(/<h([1-6]) class="widget-title"/g)].map((m) => m[1]);
const leakyPostDetailSelector = (css) => (String(css).match(/\.post-detail\s+h[1-6]\b/) || [null])[0];

// 样式表里所有沾到标题层级的选择器（去重、去注释后再取）。
// 用来和白名单整集比对 —— 逐条列「旧选择器还在不在」会漏掉我没想到的那一条。
function headingSelectors(css) {
  const out = new Set();
  for (const m of String(css).matchAll(/([^{}]+)\{/g)) {
    for (const part of m[1].split(",")) {
      const s = part.replace(/\s+/g, " ").trim();
      if (/(^|[\s>+~])h[1-6]\b/.test(s)) out.add(s);
    }
  }
  return out;
}

const ALLOWED_HEADING_SELECTORS = [
  "h1", "h2", "h3",                                   // 衬线标题（元素层级，覆盖所有标题）
  ".hero h1", ".page-head h1",                        // 首页 hero / 归档·留言·关于·会员 的页标题
  ".post-detail > h1", ".post-detail.post-anim > h1", // 文章标题（子选择器，见上）
  ".post-body h2", ".post-body h3",                   // 正文小标题
  ".prose h2", ".prose h3",                           // 关于页 / 写作预览
  ".card h2", ".card:hover h2", ".card.feature h2",   // 卡片标题
  ".member-card h2", ".guestbook-form-head h2",
];

function viewsOf(html) {
  const start = html.indexOf("<main");
  const end = html.indexOf("</main>");
  const main = start >= 0 && end > start ? html.slice(start, end) : html;
  const out = {};
  for (const seg of main.split(/(?=<section class="view )/)) {
    const m = seg.match(/^<section class="view ([a-z-]+)/);
    if (m) out[m[1]] = seg;
  }
  return out;
}

function headingSeq(html) {
  const out = [];
  for (const m of String(html).matchAll(/<h([1-6])(?:\s[^>]*)?>/gi)) out.push(Number(m[1]));
  return out;
}
// 大纲跳级：h1 直接跳到 h3 这种（辅助技术据此推断层级关系，跳级会让章节关系失真）
// 入参兼容 ["h1","h3"] 与 [1,3]：取标签名里的数字，而不是 Number("h1")（那是 NaN，
// 相减后 NaN > 1 为 false，会把跳级静默判成「没跳级」）。
function firstSkip(seq) {
  const n = seq.map((x) => Number(String(x).replace(/\D/g, "")));
  for (let i = 1; i < n.length; i++) if (n[i] - n[i - 1] > 1) return { from: n[i - 1], to: n[i], at: i };
  return null;
}

// 片段顶层标签（只取深度 0 的标签名）：用来确认 h1 是 #postDetail 的直接子元素 ——
// `.post-detail > h1` 是子选择器，h1 一旦被塞进 .post-body 里，样式就再也套不上。
function topLevelTags(html) {
  const VOID = new Set(["img", "br", "hr", "input", "meta", "link", "source", "area", "base", "col", "embed", "track", "wbr"]);
  const out = [];
  let depth = 0;
  for (const m of String(html).matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [, closing, name, rest] = m;
    const tag = name.toLowerCase();
    if (closing) { depth--; continue; }
    if (depth === 0) out.push(tag);
    if (!VOID.has(tag) && !/\/\s*$/.test(rest)) depth++;
  }
  return out;
}

const VIEWS = viewsOf(HTML);

console.log("\n[1] 每个视图恰好一个 h1，且 h1 就是「这一页的主题」");
{
  const EXPECTED = {
    "view-home": "记录与思考",
    "view-archive": "归档",
    "view-guestbook": "留言墙",
    "view-about": "关于",
    "view-member": "👥 会员专区",
  };
  for (const [cls, text] of Object.entries(EXPECTED)) {
    const list = VIEWS[cls] ? h1sIn(VIEWS[cls]) : [];
    check(`${cls} 恰好一个 h1`, list.length === 1, `实际 ${list.length} 个：${list.join(" | ")}`);
    check(`${cls} 的 h1 是页面主题「${text}」`, list[0] === text, `实际「${list[0]}」`);
  }
  check("view-post 静态壳里没有 h1（标题由 JS 渲染 / 爬虫注入）",
    h1sIn(VIEWS["view-post"] || "").length === 0,
    "静态写死标题会变成文章页的第二个 h1");
  check("view-post 保留 SSR 正文占位（爬虫的 h1 从这里进来）",
    /<!--SSR-BODY-START--><!--SSR-BODY-END-->/.test(HTML_SRC));
  check("index.html 全文恰好 5 个 h1（5 个视图各一，文章页无静态 h1）",
    h1sIn(HTML).length === 5, `实际 ${h1sIn(HTML).length} 个`);
}

console.log("\n[2] 侧边栏语义：站点名不是「本页主题」，不得占 h1");
{
  check("index.html 不再有 <h1>昉昕</h1>", !brandIsH1(HTML));
  check("站点名改用无语义容器 .brand-name",
    /<div class="brand-name">\s*昉昕\s*<\/div>/.test(HTML));
  const sb = HTML.slice(HTML.indexOf('<aside class="sidebar"'), HTML.indexOf("</aside>"));
  check("左侧边栏（站点名 + 导航 + 小部件）不含 h1", !/<h1[\s>]/.test(sb));
  const rb = HTML.slice(HTML.indexOf('<aside class="rightbar"'), HTML.lastIndexOf("</aside>"));
  check("右侧栏（此刻 / 农历）不含 h1", !/<h1[\s>]/.test(rb));
  const tb = HTML.slice(HTML.indexOf('<header class="topbar"'), HTML.indexOf("</header>"));
  check("顶部导航条不含 h1", !/<h1[\s>]/.test(tb));
  // div 不吃 h1 的默认字号，也不在衬线标题规则里 —— 降级后必须有人接手这两件事
  check("CSS 单独给 .brand-text .brand-name 补了字号",
    /\.brand-text \.brand-name\s*\{[^}]*font-size/.test(CSS),
    "站点名会掉回正文字号");
  check("CSS 衬线标题规则里包含 .brand-name",
    /h1,\s*h2,\s*h3,[^{]*\.brand-name[^{]*\{/.test(CSS),
    "站点名会从衬线体掉回无衬线体");
}

console.log("\n[3] 侧栏小部件标题：原先 h1 → h4 跳两级，现统一 h2");
{
  const lv = widgetLevels(HTML);
  check("4 个小部件标题都在", lv.length === 4, `实际 ${lv.length} 个`);
  check("小部件标题统一 h2", lv.length === 4 && lv.every((l) => l === "2"), `实际层级 ${lv.join(",")}`);
  check("index.html 不再出现 h4 / h5 / h6", !/<h[456][\s>]/.test(HTML));
}

console.log("\n[4] 文章页的 h1：前端渲染与爬虫片段必须是同一个");
{
  check("app.js 渲染正文时标题用 h1", APP_SRC.includes("<h1>${post.title}</h1>"));
  check("app.js 骨架屏标题也是 h1（首帧与终帧不能换层级）", APP_SRC.includes("<h1>${p.title}</h1>"));
  check("app.js 旧的 <h2>${post.title}</h2> 写法已清除", !APP_SRC.includes("<h2>${post.title}</h2>"));
  check("app.js 旧的 <h2>${p.title}</h2> 写法已清除", !APP_SRC.includes("<h2>${p.title}</h2>"));

  const FRAG = buildArticleHtml({
    title: "心理学的领域", tag: "读书", date: "2026-09-13", author: "zfx",
    readingMinutes: 2, words: 300, views: 7,
    coverUrl: "/generated/covers/abc123.jpg",
    bodyHtml: renderMarkdown("# 一级标题\n\n## 二级标题\n\n### 三级标题\n\n正文段落。"),
  });
  const fh = h1sIn(FRAG);
  check("爬虫片段恰好一个 h1", fh.length === 1, `实际 ${fh.length} 个`);
  check("爬虫片段的 h1 就是文章标题", fh[0] === "心理学的领域", `实际「${fh[0]}」`);
  const bodyAt = FRAG.indexOf('<div class="post-body">');
  check("h1 在 .post-body 之外（正文永远不产出 h1）",
    bodyAt > 0 && !/<h1[\s>]/.test(FRAG.slice(bodyAt)));
  check("h1 是 #postDetail 的直接子元素（否则 .post-detail > h1 匹配不到）",
    topLevelTags(FRAG).filter((t) => t === "h1").length === 1,
    "顶层标签：" + topLevelTags(FRAG).join(","));
  check("片段大纲无跳级", firstSkip(headingSeq(FRAG)) === null, JSON.stringify(headingSeq(FRAG)));

  const iTitle = APP_SRC.indexOf("<h1>${post.title}</h1>");
  const iBody = APP_SRC.indexOf('<div class="post-body">', iTitle);
  check("前端渲染的 h1 同样在 .post-body 之前", iTitle > 0 && iBody > iTitle);
  check("前端渲染的 h1 紧跟封面（与片段层级一致）",
    APP_SRC.slice(Math.max(0, iTitle - 40), iTitle).includes("${hero}"));
}

console.log("\n[5] .post-detail 的样式作用域：只能命中标题本身");
{
  check("文章标题样式锁定为直接子元素 .post-detail > h1",
    /\.post-detail\s*>\s*h1\b/.test(CSS));
  check("进场动画同样用直接子元素", /\.post-detail\.post-anim\s*>\s*h1\b/.test(CSS));
  const leak = leakyPostDetailSelector(CSS);
  check("CSS 里没有 .post-detail 的后代式标题选择器（会泄漏到正文小标题）",
    leak === null, `发现「${leak}」`);

  // 把样式表里**所有**沾到标题层级的选择器枚举出来，与白名单整集比对。
  // 比「逐个列旧选择器还在不在」彻底得多：漏改的那一条哪怕不在我的清单里，
  // 也会作为「多出来的一条」立刻暴露（这正是这类改动最容易静默出错的地方）。
  {
    const found = [...headingSelectors(CSS)].sort();
    const expected = [...ALLOWED_HEADING_SELECTORS].sort();
    const extra = found.filter((s) => !expected.includes(s));
    const missing = expected.filter((s) => !found.includes(s));
    check(`样式表的标题选择器与白名单一致（${expected.length} 条：无漏改、无残留）`,
      extra.length === 0 && missing.length === 0,
      `多出 ${JSON.stringify(extra)}；缺少 ${JSON.stringify(missing)}`);
  }

  // 衬线标题规则改成纯元素选择器：h1/h2/h3 已覆盖所有标题元素，
  // 不必再逐个列组件类名 —— 旧写法正是「把元素层级抄成类名清单」，层级一动就漏改。
  const at = CSS.indexOf("h1, h2, h3,");
  const serif = at < 0 ? "" : CSS.slice(at, CSS.indexOf("{", at)).replace(/\s+/g, " ").trim();
  check("衬线标题规则只按元素层级写（+ .brand-name 这个例外）",
    serif === "h1, h2, h3, .brand-name, .compose-meta #composeTitle", serif);
}

console.log("\n[6] 正文渲染器永不产出 h1（否则一页两个 h1）");
{
  const startAt = APP_SRC.indexOf("  function safeUrl(raw, allowDataImage) {");
  const mdAt = APP_SRC.indexOf("  function mdToHtml(md) {");
  const endAt = APP_SRC.indexOf("\n  function ", mdAt + 10);
  check("能从 app.js 中截取到 mdToHtml", mdAt > 0 && endAt > mdAt);
  const { mdToHtml } = new Function(APP_SRC.slice(startAt, endAt) + "\n  return { mdToHtml };")();

  check("mdToHtml：`# ` 落 h2（h1 留给文章标题）",
    mdToHtml("# 一级").includes('<h2 id="sec-1">一级</h2>'), mdToHtml("# 一级"));
  check("mdToHtml：`### ` 落 h3", mdToHtml("### 三级").includes("<h3 id=\"sec-1\">三级</h3>"));
  const SAMPLE = "# 一级\n\n## 二级\n\n### 三级\n\n正文段落。";
  check("mdToHtml 全层级样本里没有 h1", !/<h1[\s>]/.test(mdToHtml(SAMPLE)), mdToHtml(SAMPLE));
  check("renderMarkdown 同样不产出 h1", !/<h1[\s>]/.test(renderMarkdown(SAMPLE)));
  check("两边对同一份样本输出一致（爬虫与真人看到同一套大纲）",
    mdToHtml(SAMPLE) === renderMarkdown(SAMPLE));
}

console.log("\n[7] 大纲整体无跳级");
{
  const seq = headingSeq(HTML);
  check("index.html 标题序列非空", seq.length > 0);
  check("index.html 无跳级（不出现 h1→h3 这种）",
    firstSkip(seq) === null, `序列=${JSON.stringify(seq)} 首个跳级=${JSON.stringify(firstSkip(seq))}`);
}

console.log("\n[8] 负向验证：把改动「改回旧写法」，上面这些检测必须报警");
{
  // 用同一批检测函数去跑「故意改坏」的样本 —— 检测函数本身失效时这里会先红，
  // 避免前面那些 ✅ 变成永远为真的摆设。
  // ⚠️ 必须 replaceAll：`.post-detail > h1` 在样式表里有两处（桌面 + 窄屏媒体查询），
  //    只替第一处的话，第二处会让下面这条断言假红 —— 负向验证本身也会写错。
  const BAD_CSS = CSS.replaceAll(".post-detail > h1", ".post-detail h2");
  check("负向：CSS 改回后代选择器 → 泄漏检测报警",
    leakyPostDetailSelector(BAD_CSS) === ".post-detail h2", String(leakyPostDetailSelector(BAD_CSS)));
  check("负向：改回后代选择器后，「直接子元素」断言也会红",
    !/\.post-detail\s*>\s*h1\b/.test(BAD_CSS) && !BAD_CSS.includes(".post-detail > h1"));

  // 白名单比对必须能抓住「只改了 HTML、漏改样式」这种情况
  const BAD_ALLOW = CSS.replaceAll(".card h2 {", ".card h3 {");
  const badFound = [...headingSelectors(BAD_ALLOW)].sort();
  check("负向：卡片标题漏改（h2 留在样式表里没跟上）→ 白名单同时报多出与缺少",
    badFound.includes(".card h3") && !badFound.includes(".card h2"),
    "实际：" + badFound.filter((s) => s.includes("card")).join(","));

  const BAD_BRAND = HTML.replace(/<div class="brand-name">昉昕<\/div>/, "<h1>昉昕</h1>");
  check("负向：站点名改回 h1 → 报警", brandIsH1(BAD_BRAND) === true);
  const BAD_WIDGET = HTML.replace('<h2 class="widget-title">', '<h4 class="widget-title">');
  check("负向：小部件标题改回 h4 → 层级检测报警",
    widgetLevels(BAD_WIDGET).some((l) => l !== "2"), widgetLevels(BAD_WIDGET).join(","));

  const BAD_VIEWS = viewsOf(HTML.replace("<h1>归档</h1>", "<h1>归档</h1><h1>另一个 h1</h1>"));
  check("负向：视图里塞进第二个 h1 → 计数检测报警",
    h1sIn(BAD_VIEWS["view-archive"] || "").length === 2,
    "实际 " + h1sIn(BAD_VIEWS["view-archive"] || "").length + " 个");

  check("负向：跳级检测器有效", firstSkip(["h1", "h3"]) !== null && firstSkip(["h1", "h2"]) === null);
  check("负向：顶层标签扫描器确实能发现被塞进 .post-body 的 h1",
    topLevelTags('<div class="post-body"><h1>藏起来的标题</h1></div>').includes("h1") === false);
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
