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

console.log("\n[1] 农历库：窄屏必须按需加载，不得无条件下载 426KB");
{
  check("不再存在「无条件注入」的 IIFE 加载器",
    !/\(function\s+loadLunarLib\s*\(\)/.test(appSrc),
    "又出现了无条件的 loadLunarLib IIFE");

  check("自动加载被 isNarrow() 否定条件包住（宽屏才自动加载）",
    /if\s*\(\s*!isNarrow\(\)\s*\)\s*\{[\s\S]{0,240}loadLunarLib/.test(appSrc),
    "未找到 `if (!isNarrow())` 包裹的自动加载");

  check("存在窄屏点击入口（点 hero 那行才加载）",
    /lunarClockEl\.addEventListener\(\s*"click"/.test(appSrc),
    "未找到 lunarClock 的 click 按需加载入口");

  check("窄屏宽度变化时会补加载（横竖屏/桌面缩放）",
    /narrowMQ\.addEventListener\(\s*"change"/.test(appSrc),
    "未找到 matchMedia change 监听");

  check("已删除「农历组件加载中…」永久占位（改为显示时辰 + 时间）",
    !/农历组件加载中/.test(appSrc),
    "仍存在只显示占位的降级文案 —— 库未加载时该行应当仍有用");

  check("已彻底移除旧的 updateLunar",
    !/\bupdateLunar\b/.test(appSrc),
    "updateLunar 仍在，重构不完整");

  check("时辰由本地地支推算，不依赖 Lunar",
    /function shichenOf\(/.test(appSrc) && /DI_ZHI\[idx\]/.test(appSrc),
    "未找到本地时辰推算");
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

console.log("\n[5] 按需加载的交互样式");
{
  check(".lunar-clock 有可点击态（data-lunar-cta）",
    /\.lunar-clock\[data-lunar-cta="1"\]\s*\{[^}]*cursor:\s*pointer/.test(cssSrc),
    "未找到 data-lunar-cta 的 cursor:pointer");
  check("存在 .lunar-hint 提示样式",
    /\.lunar-hint\s*\{/.test(cssSrc),
    "未找到 .lunar-hint 样式");
  check("app.js 会设置 data-lunar-cta",
    /dataset\.lunarCta/.test(appSrc),
    "未找到 dataset.lunarCta 赋值");
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

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
