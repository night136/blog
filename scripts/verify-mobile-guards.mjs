// 移动端守护断言：把「省流量 / 不卡主线程 / 不被刘海挡」的移动端约定钉住。
// 用法：node scripts/verify-mobile-guards.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const appSrc = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
const cssSrc = fs.readFileSync(path.join(root, "assets", "style.css"), "utf8");
const htmlSrc = fs.readFileSync(path.join(root, "index.html"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     实际: " + detail : "")); }
}

// ── 取一段花括号配对的函数体 ──
// ⚠️ 这里**刻意不设长度上限**。原先下面那条 showView 断言写的是
//    `/function showView[\s\S]{0,1200}?\n  \}/` —— 1200 是一个会过期的代理指标：
//    showView 后来加了 §七#20 的滚动位置还原（自然变长），断言立刻报「未找到 showView」，
//    而代码完全正确。按花括号配对取，不管它多长，取到的总是它自己。
function fnBody(src, needle) {
  const at = src.indexOf(needle);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  if (open < 0) return null;
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") { d--; if (d === 0) return src.slice(open + 1, i); }
  }
  return null;
}

console.log("\n[1] 农历：数据内联，窄屏不再需要「按需加载」");
{
  // 这一节的前身是「窄屏不得无条件下载 426KB 的 lunar.js」。数据内联后，
  // 这个权衡整个消失了：农历随 app.js 一起到达，窄屏也照样能显示农历日期。
  // 断言前剥注释：改动说明里会**提到** lunar.js（解释为什么删它），
  // 全文匹配会把注释误判成引用。
  const appCode = appSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  check("农历数据确实内联在 app.js 里（不再依赖任何外部脚本）",
    /var LUNAR_YEAR_INFO = \[/.test(appCode) && /var LUNAR_JIEQI_DAYS =/.test(appCode) &&
    !/lunar\.js|loadLunarLib|lunarLibState/.test(appCode),
    "未找到内联数据，或仍残留外部加载逻辑");

  check("不再存在「无条件注入」的 IIFE 加载器",
    !/\(function\s+loadLunarLib\s*\(\)/.test(appSrc),
    "又出现了无条件的 loadLunarLib IIFE");

  check("窄屏也渲染农历日期（不必再点按才显示）",
    /function tickClock[\s\S]{0,1400}?lu\.month \+ "月" \+ lu\.day/.test(appSrc) &&
    !/data-lunar-cta|lunarCta/.test(appSrc),
    "hero 行未渲染农历日期，或仍保留按需加载入口");

  check("已删除「农历组件加载中…」永久占位（改为显示时辰 + 时间）",
    !/农历组件加载中|农历加载中/.test(appSrc),
    "仍存在只显示占位的降级文案 —— 库未加载时该行应当仍有用");

  check("已彻底移除旧的 updateLunar",
    !/\bupdateLunar\b/.test(appSrc),
    "updateLunar 仍在，重构不完整");

  check("时辰由本地地支推算，不依赖任何库",
    /function shichenOf\(/.test(appSrc) && /DI_ZHI\[idx\]/.test(appSrc),
    "未找到本地时辰推算");

  check("窄屏宽度变化时补渲染侧栏挂件（横竖屏/桌面缩放）",
    /narrowMQ\.addEventListener\(\s*"change"/.test(appSrc),
    "未找到 matchMedia change 监听");
}

console.log("\n[2] 农历重活不得挂在秒级定时器上");
{
  check("秒级定时器只有一个（原来是两个，各跑两遍）",
    (appSrc.match(/setInterval\(/g) || []).length === 2,
    "setInterval 数量为 " + (appSrc.match(/setInterval\(/g) || []).length + "（应为 2：秒级时钟 + 5s 轮播）");

  const clockTick = appSrc.match(/setInterval\(\(\)\s*=>\s*\{[\s\S]{0,300}?\},\s*1000\)/);
  check("存在秒级 tick 且内部调用 renderLunarDetails",
    !!clockTick && /renderLunarDetails\(\)/.test(clockTick[0]),
    clockTick ? clockTick[0].replace(/\s+/g, " ").slice(0, 160) : "未找到秒级定时器");

  check("秒级 tick 窄屏直接 return（右侧栏隐藏，不白算）",
    !!clockTick && /isNarrow\(\)\s*\)\s*return/.test(clockTick[0]),
    "秒级 tick 未做窄屏短路");

  check("秒级 tick 内不直接构造农历（无 Lunar.fromYmd / fromDate）",
    !!clockTick && !/Lunar\.(fromYmd|fromDate)\(/.test(clockTick[0]),
    "秒级 tick 内出现农历构造，会在每秒钟重建月历");

  check("renderLunarDetails 有「按日缓存」守护（避免每秒重算节气/42 个格子）",
    /function renderLunarDetails[\s\S]{0,700}?lunarDetailDayKey/.test(appSrc),
    "未找到 lunarDetailDayKey 日键守护");

  check("renderLunarDetails 在节点缺失时提前返回（窄屏没有这些节点）",
    /function renderLunarDetails[\s\S]{0,900}?if\s*\(!gzEl[\s\S]{0,80}?return/.test(appSrc),
    "未找到节点缺失短路");

  check("tickClock 每秒只改秒数文本（性能关键路径）",
    /function tickClock[\s\S]{0,900}?heroLineKey/.test(appSrc) && /querySelector\(\s*"\.lunar-time"\s*\)/.test(appSrc),
    "tickClock 缺少渲染签名缓存 / 轻量秒数更新");
}

console.log("\n[3] 视口与安全区（刘海屏 / 手势条 / 地址栏）");
{
  check("index.html viewport 含 viewport-fit=cover",
    /viewport-fit=cover/.test(htmlSrc),
    "缺少 viewport-fit=cover，env(safe-area-*) 在 iOS 上恒为 0");

  check(".sidebar 用 100dvh 且保留 100vh 兜底（回退必须在前）",
    /\.sidebar\s*\{[^}]*height:\s*100vh;\s*height:\s*100dvh/.test(cssSrc),
    "未找到 `height: 100vh; height: 100dvh` 的成对写法");

  check(".compose-full 同时有 100vh 与 100dvh（编辑器被键盘遮挡的根因）",
    (cssSrc.match(/\.compose-full\s*\{[^}]*100dvh/g) || []).length >= 2,
    "未找到两处 calc(100dvh - Npx)（桌面 + 移动端各一处）");

  check("固定定位的 hamburger 使用顶部/左侧安全区",
    /\.hamburger\s*\{[^}]*top:\s*max\(9px,\s*env\(safe-area-inset-top\)\)/.test(cssSrc) &&
    /\.hamburger\s*\{[^}]*left:\s*max\(10px,\s*env\(safe-area-inset-left\)\)/.test(cssSrc),
    "hamburger 未适配安全区");

  check(".content 底部留出手势条空间",
    /\.content\s*\{[^}]*padding-bottom:\s*calc\(20px \+ env\(safe-area-inset-bottom\)\)/.test(cssSrc),
    "未找到 content 的底部安全区补偿");

  const topbarPad = cssSrc.search(/\.topbar-inner\s*\{[^}]*padding:\s*0 14px[^}]*\}/);
  const topbarSafe = cssSrc.search(/\.topbar-inner\s*\{[^}]*padding-left:\s*max\(14px/);
  check("顶栏安全区样式写在 padding 简写之后（否则被简写重置）",
    topbarPad >= 0 && topbarSafe > topbarPad,
    "padding 简写位置=" + topbarPad + "，安全区位置=" + topbarSafe);
}

console.log("\n[4] 触屏输入框必须 ≥16px（iOS 聚焦自动放大的根因）");
{
  const gbRule = cssSrc.search(/\.guestbook-form input,\s*\.guestbook-form textarea\s*\{[^}]*\}/);
  const touchIdx = cssSrc.indexOf("触屏输入框统一");
  check("存在统一的触屏输入框字号块", touchIdx >= 0, "未找到「触屏输入框统一」标记");

  check("该块在 max-width:980px 媒体查询内",
    /触屏输入框统一[\s\S]{0,500}@media \(max-width: 980px\)/.test(cssSrc),
    "未找到配套的媒体查询");

  check("覆盖 guestbook / compose / auth / search 全部输入控件",
    /触屏输入框统一[\s\S]{0,900}\.search-box input[\s\S]{0,900}\.guestbook-form textarea[\s\S]{0,300}font-size:\s*16px/.test(cssSrc),
    "选择器清单不完整");

  check("该块位于组件自身字号之后（靠「后来居上」生效）",
    gbRule >= 0 && touchIdx > gbRule,
    "guestbook 规则位置=" + gbRule + "，触屏块位置=" + touchIdx);
}

console.log("\n[5] hero 农历行的窄屏适配");
{
  // 数据内联后窄屏也能显示农历，但横向空间依旧紧张：生肖那截在窄屏隐掉，
  // 并且允许换行 —— 320px 的机器上「丙午年八月初五 · 申时 15:52:05」会顶到边。
  check("窄屏隐藏生肖那截（.lunar-sx）",
    /@media \(max-width: 980px\)[\s\S]{0,220}\.lunar-clock \.lunar-sx\s*\{\s*display:\s*none/.test(cssSrc),
    "未找到 .lunar-sx 的窄屏隐藏规则");
  check("窄屏 hero 行允许换行（避免溢出胶囊）",
    /@media \(max-width: 980px\)[\s\S]{0,160}\.lunar-clock\s*\{[^}]*flex-wrap:\s*wrap/.test(cssSrc),
    "未找到 .lunar-clock 的窄屏 flex-wrap");
  check(".lunar-clock 仍是胶囊样式（改动没顺手改坏外观）",
    /\.lunar-clock\s*\{[^}]*border-radius:\s*999px/.test(cssSrc),
    "未找到 .lunar-clock 的 999px 圆角");
  check("已删除按需加载的交互样式（data-lunar-cta / .lunar-hint）",
    !/data-lunar-cta|lunar-hint/.test(cssSrc),
    "仍残留按需加载时代的样式");
}

console.log("\n[6] 弹窗：矮屏 / 横屏 / 键盘弹出时必须能滚到顶部");
{
  const maskRule = (cssSrc.match(/\.modal-mask\s*\{[^}]*\}/g) || []).find((r) => /position:\s*fixed/.test(r)) || "";
  check(".modal-mask 可纵向滚动（overflow-y: auto）",
    /overflow-y:\s*auto/.test(maskRule), maskRule.slice(0, 160));
  check(".modal-mask 不再用 align-items:center 居中（向上溢出的部分永远滚不到）",
    !/align-items:\s*center/.test(maskRule), maskRule.slice(0, 160));
  check("子项用 margin:auto 做安全居中（无富余时自动归零、从顶部起可滚）",
    /\.modal,\s*\.modal-auth\s*\{\s*margin:\s*auto;?\s*\}/.test(cssSrc),
    "未找到 `.modal, .modal-auth { margin: auto; }`");
  check("弹窗内滚动不把整页带着滚（overscroll-behavior: contain）",
    /overscroll-behavior:\s*contain/.test(maskRule), maskRule.slice(0, 160));
}

console.log("\n[7] 触控目标 ≥44×44 与正文操作字号");
{
  const coarseIdx = cssSrc.indexOf("@media (pointer: coarse)");
  check("存在触屏专用块（pointer: coarse，而非只按宽度断点）",
    coarseIdx >= 0, "未找到 @media (pointer: coarse)");
  const coarse = coarseIdx >= 0 ? cssSrc.slice(coarseIdx) : "";
  check("块内用 ::after 提供 44×44 热区（视觉尺寸不变）",
    /width:\s*max\(100%,\s*44px\)/.test(coarse), "未找到 max(100%, 44px) 热区");
  // × 的 44 热区已从「只在触屏块」提到全局：细指针桌面下 14×24 连 WCAG 2.2 SC 2.5.8 的
  // 24×24 下限都不到，不该只在触屏补。这里改为查全局 + 守住「不能加 position:relative」。
  // ⚠️ 必须先剥掉 CSS 注释再匹配选择器：本文件的正则是 `[^{}]*\.modal-close[^{}]*\{`，
  //    而注释里也常出现 `.modal-close` 这个词（比如解释「44 热区已提到全局」）。注释不是
  //    选择器，却会因为前面没有 `}` 被一并吞进选择器捕获组，于是**下一条无关规则**（实测是
  //    `.theme-toggle, .social-link { position: relative }`）被算作「.modal-close 写了 relative」，
  //    报出假故障。注释剥掉后捕获组才是真正的选择器。
  const cssNoComments = cssSrc.replace(/\/\*[\s\S]*?\*\//g, "");
  const closeBase = (cssNoComments.match(/\.modal-close\s*\{[^}]*\}/) || [""])[0];
  const closeRules = [...cssNoComments.matchAll(/([^{}]*\.modal-close[^{}]*)\{([^}]*)\}/g)];
  check("× 的 44 热区对所有指针生效（服务细指针桌面，不只是触屏）",
    /\.modal-close::after\s*\{[^}]*width:\s*44px/.test(cssSrc), "未找到 .modal-close::after 的 44px 热区");
  check("× 保持 position:absolute，任何 .modal-close 规则都不得写 relative（会脱出弹窗定位）",
    /position:\s*absolute/.test(closeBase) && !closeRules.some((m) => /position:\s*relative/.test(m[2])),
    "closeBase = " + closeBase.slice(0, 140));
  check("负向自检：把 .modal-close 本体改成 relative 必须判红",
    closeRules.some((m) => /position:\s*relative/.test(m[2])) === false &&
      /position:\s*relative/.test(
        (cssNoComments.replace(/\.modal-close\s*\{/, ".modal-close { position: relative;")
          .match(/\.modal-close\s*\{[^}]*\}/) || [""])[0]),
    "replace 没命中");
  check("正文操作按钮字号在触屏下 ≥13px（原来是 11px，已低于可读下限）",
    /\.post-actions button[^{]*\{[^}]*font-size:\s*13px/.test(coarse),
    "未在触屏块里提升 .post-actions 字号");
  check("编辑器工具按钮在触屏下 ≥40px（原来是 32px）",
    /\.editor-toolbar button[^{]*\{[^}]*width:\s*40px/.test(coarse),
    "未提升工具栏按钮尺寸");
  check("触屏块位于文件末尾（靠「后来居上」覆盖组件自身的 32px / 11px）",
    coarseIdx > cssSrc.indexOf(".guestbook-form input"),
    "触屏块位置=" + coarseIdx);
  check("复制按钮在触屏下常显（原来只靠 pre:hover 揭示，触屏无法触发）",
    /\.code-copy\s*\{[^}]*opacity:\s*1/.test(coarse), ".code-copy 未常显");
  check("便签删除按钮在触屏下常显（原来只靠 .g-card:hover 揭示）",
    /\.g-del\s*\{[^}]*opacity:\s*1/.test(coarse), ".g-del 未常显");
}

console.log("\n[8] 抽屉：手势 / aria-expanded / ESC 三者齐备");
{
  check("存在统一的 setSidebar(open)（class / 遮罩 / 滚动锁 / aria 一处收口）",
    /function setSidebar\s*\(\s*open\s*\)/.test(appSrc), "未找到 setSidebar");
  check("setSidebar 内同步 aria-expanded",
    /function setSidebar[\s\S]{0,700}?setAttribute\(\s*"aria-expanded"/.test(appSrc),
    "setSidebar 未同步 aria-expanded");
  check("存在右滑关闭手势（touchstart → touchmove）",
    /addEventListener\(\s*"touchstart"[\s\S]{0,300}?addEventListener\(\s*"touchmove"/.test(appSrc),
    "未找到滑动关闭手势");
  check("手势要求横向位移占主导（不与抽屉纵向滚动打架）",
    /Math\.abs\(\s*dx\s*\)\s*>\s*Math\.abs\(\s*dy\s*\)\s*\*/.test(appSrc),
    "未找到「横向主导」判定");
  check("手势监听是 passive（不阻塞滚动）",
    /\{\s*passive:\s*true\s*\}/.test(appSrc), "未找到 passive 监听");
  check("ESC 逐层关闭里包含抽屉",
    /e\.key\s*!==\s*"Escape"[\s\S]{0,400}?classList\.contains\(\s*"open"\s*\)[\s\S]{0,160}?setSidebar\(false\)/.test(appSrc),
    "ESC 未覆盖抽屉");
  const showView = fnBody(appSrc, "function showView(");
  check("showView 收起抽屉时统一走 setSidebar（不再手写三件套，避免漏掉 aria/滚动锁）",
    !!showView && /setSidebar\(false\)/.test(showView) && !/sidebar\.classList\.remove/.test(showView),
    showView ? showView.replace(/\s+/g, " ").slice(0, 200) : "未找到 showView");
  check("index.html 两个汉堡按钮都带 aria-expanded / aria-controls",
    (htmlSrc.match(/aria-expanded="false"/g) || []).length >= 2 &&
    (htmlSrc.match(/aria-controls="sidebar"/g) || []).length >= 2,
    "汉堡按钮的 aria 属性不完整");
}

console.log("\n[9] hover 效果只在「支持真实悬停」的设备上生效（消除触屏粘住的高亮）");
{
  const MQ = "@media (hover: hover) and (pointer: fine) {";
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
  let s = stripComments(cssSrc), wrapped = 0;
  for (;;) {
    const i = s.indexOf(MQ);
    if (i < 0) break;
    let depth = 0, end = -1;
    for (let j = i + MQ.length - 1; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    s = s.slice(0, i) + s.slice(end + 1);
    wrapped++;
  }
  const bare = (s.match(/:hover/g) || []).length;
  check("没有任何裸 :hover 规则（全部在 hover 能力媒体查询内）",
    bare === 0, "仍有 " + bare + " 处裸 :hover");
  check("包裹块数量与 hover 规则数一致（≥40）",
    wrapped >= 40, "包裹块仅 " + wrapped + " 个");
  check("非 hover 选择器留在媒体查询之外（:focus / .copied 在触屏上仍生效）",
    /\.code-copy:focus,\s*\.code-copy\.copied\s*\{/.test(cssSrc),
    "混合选择器被整体包进去了：触屏上复制按钮的焦点态会失效");
}

console.log("\n[10] P2 打磨：浏览器 UI 配色 / 点按反馈 / 滚动链 / 长串换行 / 字体瘦身");
{
  const themeMeta = htmlSrc.match(/<meta\s+name="theme-color"[^>]*>/);
  check("存在 theme-color meta（地址栏跟随暖米色主题）",
    !!themeMeta, "未找到 theme-color");
  check("theme-color 带 id（供 applyTheme 动态改写，才能跟随站内主题开关）",
    !!themeMeta && /\bid="theme-color"/.test(themeMeta[0]), themeMeta ? themeMeta[0] : "");
  check("theme-color 默认值是浅色主题背景（JS 未跑时也不割裂）",
    !!themeMeta && /content="#F5EFE6"/.test(themeMeta[0]), themeMeta ? themeMeta[0] : "");
  check("applyTheme 内同步 theme-color（含深色值）",
    /function applyTheme[\s\S]{0,900}?getElementById\(\s*"theme-color"\s*\)[\s\S]{0,300}?setAttribute\(\s*"content"/.test(appSrc),
    "applyTheme 未同步 theme-color");
  check("深色 theme-color 与 CSS 变量 --bg 的深色值一致（#2A2621）",
    /mode === "dark" \? "#2A2621" : "#F5EFE6"/.test(appSrc),
    "深色主题色与 [data-theme=dark] 的 --bg 不一致");

  const htmlRule = (cssSrc.match(/(?:^|\n)html\s*\{[^}]*\}/) || [])[0] || "";
  check("html 锁定文字缩放（-webkit-text-size-adjust: 100%）",
    /-webkit-text-size-adjust:\s*100%/.test(htmlRule), htmlRule.slice(0, 200));
  check("html 去掉点按灰块闪烁（-webkit-tap-highlight-color: transparent）",
    /-webkit-tap-highlight-color:\s*transparent/.test(htmlRule), htmlRule.slice(0, 200));

  const baseSidebar = (cssSrc.match(/\.sidebar\s*\{[^}]*\}/g) || []).find((r) => /position:\s*sticky/.test(r)) || "";
  check("侧栏/抽屉内滚动不带动整页（overscroll-behavior: contain）",
    /overscroll-behavior:\s*contain/.test(baseSidebar), baseSidebar.slice(0, 200));

  check("正文长 URL 会就地折行（.post-body overflow-wrap: anywhere）",
    /\.post-body\s*\{[^}]*overflow-wrap:\s*anywhere/.test(cssSrc), "未找到 overflow-wrap: anywhere");

  check("便签列宽用 minmax(0,1fr)（1fr 的 min-content 下限会被长串撑破）",
    /\.g-board-inner\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(cssSrc),
    "窄屏便签列未加 minmax(0,1fr)");
  const g380 = cssSrc.search(/@media \(max-width: 380px\)/);
  check("超窄屏（≤380px）便签回落单列",
    g380 >= 0 && /@media \(max-width: 380px\)\s*\{\s*\.g-board-inner\s*\{\s*grid-template-columns:\s*1fr/.test(cssSrc),
    "未找到 ≤380px 的单列兜底");
  const g640 = cssSrc.search(/@media \(max-width: 640px\)\s*\{[\s\S]{0,200}?\.g-board-inner/);
  check("380 兜底写在 640 之后（否则不生效）",
    g380 > g640, "640 块位置=" + g640 + "，380 块位置=" + g380);

  // 字体链接现在住在 app.js 的 FONT_CSS_URL 里（index.html 那条已被移除，改由 JS 首绘后注入，
  // 因为它 91KB gzip 且是跨站渲染阻塞资源，会把整页首绘一起拖住）。
  // 这里仍然只关心「请求了几档字重」—— 与「从哪儿加载」是两件事，所以换成从 app.js 取 URL。
  // 顺便断言 index.html 里**没有**剩下那条阻塞链接：这是首绘性能的关键，见 verify-first-paint。
  const fontLink =
    (appSrc.match(/FONT_CSS_URL\s*=\s*"([^"]+)"/) || [])[1] ||
    (htmlSrc.match(/fonts\.font\.im\/css2\?[^"]+/) || [])[0] || "";
  check("字体只请求 3 档字重（砍掉 600，视觉靠就近回退）",
    /wght@400;700;900\b/.test(fontLink) && !/;600\b/.test(fontLink), "字体链接：" + fontLink);
  check("保留 900（Bento 标题的核心字重，砍了会明显变细）",
    /wght@[\d;]*900/.test(fontLink), "字体链接：" + fontLink);
  check("字体已改为非阻塞注入（index.html 不再有阻塞的字体样式表）",
    !/<link[^>]+fonts\.font\.im[^>]*stylesheet/.test(htmlSrc) && /function loadWebFont\(/.test(appSrc),
    "index.html 仍有阻塞字体链接，或 app.js 缺少 loadWebFont");

  const logoPath = path.join(root, "assets", "logo.jpg");
  const logoReferenced = /logo\.jpg/.test(htmlSrc + appSrc + cssSrc);
  check("未被引用的 assets/logo.jpg 残留已清理",
    !fs.existsSync(logoPath) || logoReferenced,
    "assets/logo.jpg 存在（476KB）却没有任何页面引用");
}

console.log("\n[11] 首页轮播：高度自适应、卡片尺寸稳定、触屏可滑动");
{
  // 起因（真机实测，390/360px 移动视口）：
  //   ① `.slider{height:240px}` + 卡片 align-items:flex-end ⇒ 卡片内容一高（2 行标题/2 行摘要）
  //      就向上顶出容器，被 overflow:hidden 裁掉 —— 390px 裁 11.9px、360px 裁 37.4px，
  //      标签药丸被拦腰切断、箭头压住标题。
  //   ② `.slide-overlay{width:auto}` 在 flex 里是 shrink-to-fit ⇒ 同一组 5 张卡片宽度
  //      在 46%~91%（163px~324px）之间跳，翻页时边界来回弹。
  //   ③ 轮播没有任何 touch 监听，且 hoverPaused 只由 mouseenter 驱动 ⇒
  //      手机既不能滑动切图、也永远无法暂停自动播放。
  //   ④ 圆点 8×8 且无热区，箭头 42×42，都在 44px 之下。
  //   ⑤ （第二版）卡片满宽（flex:1 1 auto，左右各 16px）时横向占 91%、纵向占 62%~76%，
  //      封面几乎被整张盖住，用户反馈「挡到照片」⇒ 改成 76% 固定宽度 + 左侧锚定。
  //      副作用：宽度改用百分比后，360/390/430 三档露出的封面比例一致。
  const block = (css, sel) => {
    const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
    return m ? m[1] : null;
  };
  // 「.slider 里有没有写死 height」——min-height 不算（前面那个连字符被 [\s;] 挡住）
  const sliderHasFixedHeight = (css) => {
    const b = block(css, ".slider");
    return !b || /(^|[\s;])height\s*:/.test(b);
  };
  // 「移动端卡片 = 固定比例宽度 + 左侧锚定」：两头都不许走回头路 ——
  //   `width: auto`（flex 里是 shrink-to-fit，宽度随内容抖）
  //   `flex: 1 1 auto`（满宽，左右各 16px，封面被整张盖住，用户反馈「挡到照片」）
  // 取文件里带 `flex: 0 0 <n>%` 的那条 .slide-overlay（桌面那条是 width:auto/max-width:600px）。
  // ⚠️ 别在这里断言「左边距 < 右边距」：卡片靠左不是因为外边距不对称，而是 flex-basis 只有
  //    76%，剩余空间按 justify-content:flex-start 全落在右边（所以右边距写 0 才是对的）。
  const mobileCardRule = (css) =>
    [...css.matchAll(/\.slide-overlay\s*\{([^}]*)\}/g)].map((m) => m[1])
      .find((b) => /flex:\s*0 0 [\d.]+%/.test(b)) || null;
  const mobileCardIsFixedLeft = (css) => {
    const b = mobileCardRule(css);
    if (!b) return false;
    const basis = parseFloat((b.match(/flex:\s*0 0 ([\d.]+)%/) || [])[1]);
    const m = b.match(/margin:\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/);   // top right bottom left
    if (!m || !(basis > 0 && basis < 100)) return false;             // 满宽（100%）不算
    return parseFloat(m[4]) <= 16 && !/width:\s*auto/.test(b) && !/flex:\s*1/.test(b);
  };

  check("轮播容器不再写死高度（改由「内容 + min-height 下限」决定）",
    !sliderHasFixedHeight(cssSrc), "`.slider{}` 里仍有 height:" + block(cssSrc, ".slider"));
  check("5 张 slide 叠在同一个 grid 单元格（行高 = 最高那张，容器自己长高）",
    /\.slides\s*\{[^}]*display:\s*grid/.test(cssSrc) && /\.slide\s*\{[^}]*grid-area:\s*1\s*\/\s*1/.test(cssSrc),
    "未使用 grid 叠放，或 .slide 缺少 grid-area");
  check("slide 有 min-height 下限 + padding-top 呼吸位（短内容也保持画幅、长内容不贴顶）",
    /\.slide\s*\{[^}]*min-height:\s*\d+px/.test(cssSrc) && /\.slide\s*\{[^}]*padding-top:\s*\d+px/.test(cssSrc),
    "缺少 min-height 或 padding-top");
  check("移动端卡片固定比例宽度 + 左侧锚定（右侧留出封面，不再满宽盖住整张照片）",
    mobileCardIsFixedLeft(cssSrc), "未找到 `flex: 0 0 <n>%`，或左外边距不小于右外边距（卡片没靠左）");
  check("窄屏隐藏箭头（左箭头与卡片重叠，触屏走「滑动 + 圆点」）",
    /\.slider-arrow\s*\{\s*display:\s*none/.test(cssSrc),
    "≤640px 仍在显示箭头（左箭头会压住卡片左上角的标签/标题）");
  check("封面加了底部渐变遮罩，且无封面 slide 排除在外",
    /\.slide:not\(\.no-cover\)::after\s*\{[^}]*linear-gradient\(to top/.test(cssSrc),
    "未找到封面渐变遮罩");
  check("触屏圆点有 44px 纵向热区（横向只到节距，避免相邻热区重叠点错）",
    /\.slider-dots \.dot::after\s*\{[^}]*height:\s*44px/.test(cssSrc),
    "未找到圆点热区");
  check("触屏箭头放大到 44×44",
    /@media \(pointer: coarse\)\s*\{[\s\S]{0,400}?\.slider-arrow\s*\{\s*width:\s*44px/.test(cssSrc),
    "coarse 块里没有把箭头放大到 44px");

  check("轮播补了 touch 滑动监听（touchstart/move/end/cancel 四件套）",
    ["touchstart", "touchmove", "touchend", "touchcancel"].every((t) => appSrc.includes(`addEventListener("${t}"`)),
    "缺少某些 touch 监听");
  check("滑动只在「横向明显占优」时才切图，纵向让位给页面滚动",
    /Math\.abs\(dy\) > Math\.abs\(dx\) \* SWIPE_SLOPE/.test(appSrc),
    "没有纵向让位判定（在轮播上下滑会滚不动页面）");
  check("滑动后抑制补发的 click（否则顺手打开一篇文章）",
    /suppressSlideClick = Date\.now\(\)/.test(appSrc) && /function swipeJustHappened\(\)/.test(appSrc),
    "缺少 click 抑制");
  check("手指按住即暂停自动播放（触屏没有 mouseleave 兜底，抬手必须恢复）",
    /hoverPaused = true; stopAuto\(\);/.test(appSrc) && /hoverPaused = false; startAuto\(\);    \/\/ 抬手恢复/.test(appSrc),
    "触屏暂停/恢复不完整");
  check("摘要与标题重复时不渲染（空摘要会被 loadPosts 回落成标题）",
    /autoFromTitle/.test(appSrc) && /s !== t && s !== autoFromTitle/.test(appSrc),
    "缺少摘要去重");
  check("非活动 slide 标 inert（读屏不连读 5 篇标题、按钮不进 Tab 序）",
    appSrc.includes('" inert"') && /toggleAttribute\("inert"/.test(appSrc),
    "未使用 inert");
  check("轮播圆点有可读名称 + 当前位置",
    appSrc.includes('aria-label="第 ${i + 1} 张') && /aria-current=/.test(appSrc),
    "圆点缺少 aria-label / aria-current");

  // 负向自检：把三条关键规则分别改坏，同一批判定必须变红（否则断言是空的）
  const broken1 = cssSrc.replace(".slider { position: relative;", ".slider { height: 240px; position: relative;");
  check("负向自检：给 .slider 写回 height 必须判红",
    broken1 !== cssSrc && sliderHasFixedHeight(broken1), "变异没生效，断言可能失效");
  // 旧病历 ①：width:auto（shrink-to-fit，宽度随内容抖）
  const broken2 = cssSrc.replace("flex: 0 0 76%;", "width: auto;");
  check("负向自检：把卡片退回 width:auto 必须判红",
    broken2 !== cssSrc && !mobileCardIsFixedLeft(broken2), "变异没生效，断言可能失效");
  // 旧病历 ②：flex:1 满宽（盖住整张封面）
  const broken3 = cssSrc.replace("flex: 0 0 76%;", "flex: 1 1 auto;");
  check("负向自检：把卡片改回满宽必须判红",
    broken3 !== cssSrc && !mobileCardIsFixedLeft(broken3), "变异没生效，断言可能失效");
  // 旧病历 ③：flex-basis 拉满 100%（等于又变回满宽）
  const broken4 = cssSrc.replace("flex: 0 0 76%;", "flex: 0 0 100%;");
  check("负向自检：把卡片 flex-basis 拉到 100% 必须判红",
    broken4 !== cssSrc && !mobileCardIsFixedLeft(broken4), "变异没生效，断言可能失效");
  // 旧病历 ④：左边距被推远（卡片不再贴左，「整体变左一点」的诉求失效）
  const broken5 = cssSrc.replace("margin: 0 0 34px 14px;", "margin: 0 0 34px 40px;");
  check("负向自检：把卡片左边距推到 40px 必须判红",
    broken5 !== cssSrc && !mobileCardIsFixedLeft(broken5), "变异没生效，断言可能失效");
}

console.log("\n[12] Hero 头像：贴左版式（左右 margin 不得为 auto）+ 窄屏尺寸覆盖必须在基样式之后");
{
  // 两个历史坑（都是「看着写了、其实没生效」）：
  // ① 窄屏 60px 曾写在 @media (max-width: 980px) 里，但那条规则在 .hero-avatar 基样式**之前** ——
  //    同优先级下后写的赢 ⇒ 60px 从未生效（实测手机上一直是 72px）。
  // ② 头像的水平位置**只**由左右 margin 决定（hero 整体靠 text-align:center，而 text-align
  //    **管不了块级盒子**）。用户选定的版式是「头像贴左上角 + 标题与描述居中」⇒ 左右 margin 必须是 0。
  //    一旦写成 auto 就会被静默居中（曾有一版如此，用户看后要求退回左边）。
  // 所以这里不能只查「有没有写」，要**按层叠顺序**判定哪一条真正生效，并守住「不许自动居中」。

  // ⚠️ 先剥注释：注释里会**提到** .hero-avatar（解释为什么这么写），
  //    不剥的话注释文字会被当成选择器（上一节就踩过这个坑）。
  //    用等长空格替换（而不是删掉），保证 match.index 仍是原文件偏移。
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));

  // @media 块的括号范围：用真括号匹配，不能靠「找到下一个 }」（大括号会嵌套）
  function mediaRangesOf(code) {
    const out = [];
    for (const mm of code.matchAll(/@media\s*([^{]+)\{/g)) {
      const open = mm.index + mm[0].length - 1;
      let d = 0, i = open;
      for (; i < code.length; i++) { if (code[i] === "{") d++; else if (code[i] === "}" && --d === 0) break; }
      out.push({ open, end: i, cond: mm[1].trim() });
    }
    return out;
  }
  // 逐条选择器比对（而不是整段字符串 includes），免得 `.x .hero-avatar` 之类的后代选择器混进来
  function rulesFor(src, sel) {
    const code = stripComments(src);
    const media = mediaRangesOf(code);
    const out = [];
    for (const rm of code.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      if (!rm[1].split(",").map((s) => s.trim()).includes(sel)) continue;
      out.push({ idx: rm.index, media: media.find((r) => rm.index > r.open && rm.index < r.end) || null, body: rm[2] });
    }
    return out;
  }
  const decl = (body, prop) => {
    const d = body.match(new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)"));
    return d ? d[1].trim() : null;
  };
  // 水平 margin：兼容 `margin: a b c` 简写与 margin-left / margin-right 长写。
  // 「上 左右」「上 左右 下」「上 右 下 左」都要认，长写覆盖简写。
  function horizMargins(body) {
    const sh = decl(body, "margin");
    const p = sh ? sh.split(/\s+/).filter(Boolean) : [];
    const pick = (i) => (p.length === 1 ? p[0] : p.length === 2 ? p[1] : p.length === 3 ? p[1] : p.length >= 4 ? p[i] : null);
    let left = pick(3), right = pick(1);
    const el = decl(body, "margin-left"); if (el) left = el;
    const er = decl(body, "margin-right"); if (er) right = er;
    return { left, right };
  }
  // 「写对了」的判据：① 左右 margin 不许 auto（否则头像被静默居中）
  //                ② 最后一条设 width 的规则落在 max-width:980px 里且在 base 之后
  function heroAvatarSafe(src) {
    const rules = rulesFor(src, ".hero-avatar");
    const base = rules.find((r) => !r.media);
    if (!base) return false;
    const hm = horizMargins(base.body);
    if (hm.left === "auto" || hm.right === "auto") return false;
    const withW = rules.filter((r) => decl(r.body, "width"));
    const eff = withW[withW.length - 1];                      // 同优先级 + 无 !important ⇒ 最后一条赢
    return !!eff && !!eff.media && /max-width:\s*980px/.test(eff.media.cond) && eff.idx > base.idx;
  }

  check("基样式左右 margin 不得为 auto（否则块级头像被静默居中，与选定版式不符）",
    (() => {
      const base = rulesFor(cssSrc, ".hero-avatar").find((r) => !r.media);
      const hm = base ? horizMargins(base.body) : { left: null, right: null };
      return hm.left !== "auto" && hm.right !== "auto";
    })(),
    "水平 margin = " + (() => {
      const b = rulesFor(cssSrc, ".hero-avatar").find((r) => !r.media);
      if (!b) return "(没有 base 规则)";
      const hm = horizMargins(b.body);
      return `left=${hm.left} right=${hm.right}`;
    })());

  check("窄屏尺寸由基样式**之后**的 @media (max-width: 980px) 覆盖（曾写在前面 ⇒ 死规则）",
    heroAvatarSafe(cssSrc),
    (() => {
      const rs = rulesFor(cssSrc, ".hero-avatar").filter((r) => decl(r.body, "width"));
      const base = rulesFor(cssSrc, ".hero-avatar").find((r) => !r.media);
      return rs.map((r) => `width:${decl(r.body, "width")} @${r.media ? r.media.cond : "无条件"} idx=${r.idx}`).join(" | ") +
        "  baseIdx=" + (base ? base.idx : "?");
    })());

  // 口径自证：一个「窄屏写在前」的合成样本必须判红，反过来必须判绿
  const GOOD_ORDER = ".hero-avatar { width: 72px; margin: 0 0 14px; }\n@media (max-width: 980px) { .hero-avatar { width: 60px; } }";
  const BAD_ORDER = "@media (max-width: 980px) { .hero-avatar { width: 60px; } }\n.hero-avatar { width: 72px; margin: 0 0 14px; }";
  const BAD_CENTER = ".hero-avatar { width: 72px; margin: 0 auto 14px; }\n@media (max-width: 980px) { .hero-avatar { width: 60px; } }";
  const BAD_CENTER_LONGHAND = ".hero-avatar { width: 72px; margin: 0 0 14px; margin-left: auto; }\n@media (max-width: 980px) { .hero-avatar { width: 60px; } }";
  check("自证：贴左 + 窄屏覆盖写在基样式之后 → 判绿（口径正确，不是恒 false）",
    heroAvatarSafe(GOOD_ORDER) === true);
  check("负向自检：把窄屏覆盖挪回基样式**之前**必须判红（正是那个死规则病历）",
    heroAvatarSafe(BAD_ORDER) === false);
  check("负向自检：`margin: 0 auto 14px` 必须判红（会把头像重新居中，正是被用户退回的那一版）",
    heroAvatarSafe(BAD_CENTER) === false);
  check("负向自检：长写 `margin-left: auto` 也要判红（简写看着没事，长写偷偷居中）",
    heroAvatarSafe(BAD_CENTER_LONGHAND) === false);
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
