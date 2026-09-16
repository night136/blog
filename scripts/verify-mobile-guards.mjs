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
  check("给 .modal-close 加了 44 热区、但没有给它 position:relative（会脱出弹窗定位）",
    /\.modal-close::after\s*\{[^}]*44px/.test(coarse) &&
    !/\.modal-close[^{]*\{[^}]*position:\s*relative/.test(coarse),
    "modal-close 的 44 热区 / 定位处理有误");
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
  const showView = appSrc.match(/function showView[\s\S]{0,1200}?\n  \}/);
  check("showView 收起抽屉时统一走 setSidebar（不再手写三件套，避免漏掉 aria/滚动锁）",
    !!showView && /setSidebar\(false\)/.test(showView[0]) && !/sidebar\.classList\.remove/.test(showView[0]),
    showView ? showView[0].replace(/\s+/g, " ").slice(0, 200) : "未找到 showView");
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
  const block = (css, sel) => {
    const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
    return m ? m[1] : null;
  };
  // 「.slider 里有没有写死 height」——min-height 不算（前面那个连字符被 [\s;] 挡住）
  const sliderHasFixedHeight = (css) => {
    const b = block(css, ".slider");
    return !b || /(^|[\s;])height\s*:/.test(b);
  };
  // 「移动端卡片占满一行」——flex:1 1 auto 才能抗住内容宽度变化
  const mobileCardIsFullWidth = (css) =>
    /\.slide-overlay\s*\{[^}]*flex:\s*1 1 auto/.test(css);

  check("轮播容器不再写死高度（改由「内容 + min-height 下限」决定）",
    !sliderHasFixedHeight(cssSrc), "`.slider{}` 里仍有 height:" + block(cssSrc, ".slider"));
  check("5 张 slide 叠在同一个 grid 单元格（行高 = 最高那张，容器自己长高）",
    /\.slides\s*\{[^}]*display:\s*grid/.test(cssSrc) && /\.slide\s*\{[^}]*grid-area:\s*1\s*\/\s*1/.test(cssSrc),
    "未使用 grid 叠放，或 .slide 缺少 grid-area");
  check("slide 有 min-height 下限 + padding-top 呼吸位（短内容也保持画幅、长内容不贴顶）",
    /\.slide\s*\{[^}]*min-height:\s*\d+px/.test(cssSrc) && /\.slide\s*\{[^}]*padding-top:\s*\d+px/.test(cssSrc),
    "缺少 min-height 或 padding-top");
  check("移动端卡片固定占满一行（不再按内容收缩）",
    mobileCardIsFullWidth(cssSrc), "未找到 flex: 1 1 auto");
  check("窄屏隐藏箭头（卡片满宽后箭头必然压住标题，改用滑动 + 圆点）",
    /\.slider-arrow\s*\{\s*display:\s*none/.test(cssSrc),
    "≤640px 仍在显示箭头（实测与卡片重叠 42px）");
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

  // 负向自检：把两条关键规则改坏，同一批判定必须变红（否则断言是空的）
  const broken1 = cssSrc.replace(".slider { position: relative;", ".slider { height: 240px; position: relative;");
  check("负向自检：给 .slider 写回 height 必须判红",
    broken1 !== cssSrc && sliderHasFixedHeight(broken1), "变异没生效，断言可能失效");
  const broken2 = cssSrc.replace("flex: 1 1 auto; margin: 0 16px 34px 16px;", "width: auto; margin: 0 16px 34px 16px;");
  check("负向自检：把卡片退回 width:auto 必须判红",
    broken2 !== cssSrc && !mobileCardIsFullWidth(broken2), "变异没生效，断言可能失效");
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
