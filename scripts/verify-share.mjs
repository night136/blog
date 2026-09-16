// 分享功能守护断言：把「分享能真的发出去 / 复制不会静默失败 / 二维码不拖慢首屏」这些约定钉住。
// 用法：node scripts/verify-share.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

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

console.log("\n[1] 分享 URL：必须基于 canonical，而不是 location.pathname");
{
  check("存在 SITE_PATH（取自 canonical 的 pathname）",
    /const SITE_PATH\s*=\s*\(\(\)\s*=>\s*\{[\s\S]{0,220}?new URL\(c\.href\)\.pathname/.test(appSrc),
    "未找到 SITE_PATH");
  check("postShareUrl = SITE_ORIGIN + SITE_PATH + ?post=",
    /function postShareUrl\s*\(\s*slug\s*\)\s*\{\s*return SITE_ORIGIN \+ SITE_PATH \+ "\?post=" \+ encodeURIComponent\(slug\)/.test(appSrc),
    "postShareUrl 构造不符");
  check("slug 走 encodeURIComponent（中文 slug 不会拼出坏 URL）",
    /postShareUrl[\s\S]{0,140}?encodeURIComponent\(slug\)/.test(appSrc),
    "未对 slug 编码");
  check("旧的 location.pathname 拼法已彻底移除",
    !/location\.pathname\s*\+\s*"\?post="/.test(appSrc),
    "仍在用 location.pathname 拼分享链接（会把 /index.html 这类别名路径传播出去）");
}

console.log("\n[2] 复制：三级降级，且不允许静默失败");
{
  check("存在 legacyCopy 兜底（execCommand）",
    /function legacyCopy[\s\S]{0,600}?execCommand\(\s*"copy"\s*\)/.test(appSrc),
    "未找到 execCommand 兜底");
  check("copyText 先判断 isSecureContext（非安全上下文里 clipboard 存在但必 reject）",
    /function copyText[\s\S]{0,300}?window\.isSecureContext/.test(appSrc),
    "未判断 isSecureContext");
  check("异步剪贴板失败后落到 legacyCopy（不是直接吞掉）",
    /navigator\.clipboard\.writeText\(text\)\.then\(\(\)\s*=>\s*true,\s*\(\)\s*=>\s*legacyCopy\(text\)\)/.test(appSrc),
    "clipboard 失败未降级");
  check("全失败时给出可操作提示（长按手动复制）",
    /复制失败，请长按输入框手动复制/.test(appSrc),
    "未找到失败提示文案");
  check("旧的静默写法规避（writeText(...).catch(() => {})）",
    !/writeText\([^)]*\)\.then\([^)]*\)\.catch\(\(\)\s*=>\s*\{\}\)/.test(appSrc) &&
    !/clipboard\.writeText\(url\)[\s\S]{0,80}?catch\(\(\)\s*=>\s*\{\}\)/.test(appSrc),
    "仍存在静默吞错的剪贴板调用");
}

console.log("\n[3] 轻提示 toast 取代 alert");
{
  check("app.js 定义 toast()",
    /function toast\s*\(\s*msg\s*\)/.test(appSrc), "未找到 toast");
  check("toast 用 textContent 渲染（天然防注入）",
    /function toast[\s\S]{0,420}?el\.textContent\s*=\s*msg/.test(appSrc),
    "toast 未使用 textContent");
  check("分享成功不再用 alert",
    !/alert\(\s*"文章链接已复制到剪贴板"\s*\)/.test(appSrc),
    "仍在用 alert 报复制成功");
  check("index.html 有 toast 容器 + role=status + aria-live",
    /<div class="toast" id="toast" role="status" aria-live="polite" hidden><\/div>/.test(htmlSrc),
    "未找到 toast 容器");
  check("style.css 定义 .toast 与 .toast.show",
    /\.toast\s*\{/.test(cssSrc) && /\.toast\.show\s*\{/.test(cssSrc),
    "未找到 toast 样式");
  check("toast 的 z-index 高于弹窗遮罩（面板内复制也要看得见）",
    /\.toast\s*\{[^}]*z-index:\s*200/.test(cssSrc),
    "toast 层级不足");
}

console.log("\n[4] 分享面板结构（index.html）");
{
  check("存在 #shareModal（复用 .modal-mask 骨架）",
    /<div class="modal-mask" id="shareModal" hidden>/.test(htmlSrc),
    "未找到 #shareModal");
  check("面板是 dialog 且有 aria-modal / aria-labelledby",
    /class="modal share-panel" role="dialog" aria-modal="true" aria-labelledby="shareHeading"/.test(htmlSrc),
    "面板无障碍属性不完整");
  const channels = ["system", "wechat", "weibo", "x", "telegram", "copy"];
  const missing = channels.filter((c) => !new RegExp(`data-channel="${c}"`).test(htmlSrc));
  check("六个渠道按钮齐全（system/wechat/weibo/x/telegram/copy）",
    missing.length === 0, "缺：" + missing.join(", "));
  check("有二维码 canvas 与链接输入框",
    /<canvas class="share-qr" id="shareQr"/.test(htmlSrc) && /<input class="share-link" id="shareLink"[^>]*readonly/.test(htmlSrc),
    "二维码 canvas 或只读链接框缺失");
  check("链接框是 readonly（不可被误改）",
    /id="shareLink"[^>]*readonly/.test(htmlSrc), "shareLink 不是 readonly");
  check("有「复制标题 + 链接」按钮",
    /id="shareCopyTitle"/.test(htmlSrc), "未找到 shareCopyTitle");
  check("有独立关闭按钮（可被 ESC / 遮罩之外的第三种方式关闭）",
    /id="shareClose"/.test(htmlSrc), "未找到 shareClose");
}

console.log("\n[5] 环境分支：微信内 / 系统分享 / 桌面二维码");
{
  check("检测微信内置浏览器",
    /IN_WECHAT\s*=\s*\/MicroMessenger\/i\.test\(navigator\.userAgent/.test(appSrc),
    "未检测 MicroMessenger");
  check("微信内给出「点右上角」引导",
    /点右上角 ··· → 发送给朋友/.test(appSrc) &&
    /function openShare[\s\S]{0,1400}?tip\.hidden = !IN_WECHAT/.test(appSrc),
    "微信内引导缺失");
  check("系统分享按钮按 navigator.share 能力显隐（不支持就不会出现死按钮）",
    /sysBtn\.hidden = typeof navigator\.share !== "function"/.test(appSrc),
    "系统分享按钮未按能力显隐");
  check("微信内点「微信」只提示、不画二维码（扫自己的码没意义）",
    /if \(IN_WECHAT\) \{ toast\("点右上角 ··· 发送给朋友"\); return; \}[\s\S]{0,120}?renderShareQr/.test(appSrc),
    "微信内分支不正确");
  check("系统分享走 navigator.share 且失败不抛",
    /navigator\.share\(\{ title, url \}\)\.catch\(\(\)\s*=>\s*\{\}\)/.test(appSrc),
    "系统分享调用不符");
}

console.log("\n[6] 二维码：本地库、按需加载、可扫");
{
  const libPath = path.join(root, "assets", "vendor", "qrcode.js");
  check("二维码库文件存在", fs.existsSync(libPath), "缺少 assets/vendor/qrcode.js");
  check("库是懒加载（不在 HTML 里静态引入）",
    !/<script[^>]+qrcode\.js/.test(htmlSrc), "HTML 里静态引了二维码库，白白多 56KB");
  check("ensureQrLib 懒加载并带失败重试（失败后清空 loading 允许重试）",
    /function ensureQrLib[\s\S]{0,600}?s\.src = "assets\/vendor\/qrcode\.js"[\s\S]{0,300}?qrLibLoading = null/.test(appSrc),
    "懒加载实现不符");
  // 注意必须把检查限定在 renderShareQr 函数体内：app.js 另有一处上传图片压缩也用
  // `ctx.fillStyle = "#FFFFFF"`，全文范围内匹配会让这条断言形同虚设（负向验证踩到过）。
  const renderQrFn = (appSrc.match(/async function renderShareQr[\s\S]{0,1800}?\n  \}/) || [""])[0];
  check("二维码固定白底深码（不跟随主题，保证对比度可扫）",
    !!renderQrFn && /ctx\.fillStyle = "#FFFFFF"/.test(renderQrFn) && /ctx\.fillStyle = "#1A1815"/.test(renderQrFn),
    "renderShareQr 内未使用固定白底深码");
  check("QR 绘制不引用主题变量（深色主题下用主题色会拉低对比度）",
    !!renderQrFn && !/var\(--/.test(renderQrFn) && !/getComputedStyle/.test(renderQrFn),
    "renderShareQr 内出现主题变量");
  check("留了 4 模块静区（扫码规范要求）",
    /const quiet = 4;/.test(appSrc), "未找到静区");
  check("用 canvas 逐模块绘制（不依赖库自带 DOM 渲染）",
    /qr\.isDark\(r, c\)\) ctx\.fillRect/.test(appSrc), "未逐模块绘制");
  check("二维码加载失败有降级提示",
    /二维码加载失败，可先复制链接/.test(appSrc), "缺少二维码失败降级");

  // 真实编码验证：把库 require 进来，确认它能生成结构正确的二维码
  try {
    const require = createRequire(import.meta.url);
    const qrcode = require(libPath);
    const qr = qrcode(0, "M");
    qr.addData("https://blog-6p3.pages.dev/?post=reading-notes-deep-work");
    qr.make();
    const n = qr.getModuleCount();
    const finderOk = qr.isDark(0, 0) && qr.isDark(3, 3) && !qr.isDark(1, 1) && !qr.isDark(7, 7) &&
      qr.isDark(0, n - 1) && qr.isDark(n - 1, 0);
    let dark = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark++;
    const ratio = dark / (n * n);
    check("库能真的生成二维码（三个定位图案齐全）", finderOk, "定位图案异常，n=" + n);
    check("暗模块占比合理（非空白/非全黑）",
      ratio > 0.3 && ratio < 0.65, "占比=" + ratio.toFixed(3));
    check("长 URL 能自动升版本容纳（n ≥ 21）", n >= 21, "n=" + n);
  } catch (e) {
    check("库能真的生成二维码", false, String(e && e.message));
  }
}

console.log("\n[7] 交互 / 无障碍 / 安全");
{
  check("ESC 逐层关闭里分享面板排在最前",
    /if \(e\.key !== "Escape"\) return;\s*\n\s*const shareHost = \$\("shareModal"\);[\s\S]{0,140}?closeShare\(\)/.test(appSrc),
    "ESC 未把分享面板纳入逐层关闭");
  check("点遮罩也能关（e.target === host）",
    /host\.addEventListener\("click", \(e\) => \{ if \(e\.target === host\) closeShare\(\); \}\)/.test(appSrc),
    "未支持点遮罩关闭");
  check("关闭后把焦点还给触发按钮",
    /shareReturnFocus = document\.activeElement/.test(appSrc) &&
    /shareReturnFocus\.focus\(\)/.test(appSrc),
    "未做焦点还原");
  check("面板打开时锁 body 滚动，关闭时解锁",
    /host\.hidden = false;[\s\S]{0,120}?document\.body\.style\.overflow = "hidden"/.test(appSrc) &&
    /host\.hidden = true;[\s\S]{0,120}?document\.body\.style\.overflow = ""/.test(appSrc),
    "未锁/未解 body 滚动");
  check("微博 / X / Telegram 三家的 URL 都做了 encodeURIComponent",
    (appSrc.match(/encodeComponentPlaceholder/g) || []).length === 0 &&
    /weibo: "[^"]+" \+ encodeURIComponent\(url\) \+ "&title=" \+ encodeURIComponent\(title\)/.test(appSrc) &&
    /x: "https:\/\/twitter\.com\/intent\/tweet\?url=" \+ encodeURIComponent\(url\) \+ "&text=" \+ encodeURIComponent\(title\)/.test(appSrc) &&
    /telegram: "https:\/\/t\.me\/share\/url\?url=" \+ encodeURIComponent\(url\) \+ "&text=" \+ encodeURIComponent\(title\)/.test(appSrc),
    "渠道 URL 未完整编码（标题含 & 会截断参数）");
  check("外链窗口带 noopener,noreferrer",
    /window\.open\(target, "_blank", "noopener,noreferrer"\)/.test(appSrc),
    "window.open 缺少安全参数");
  check("面板内容全部用 textContent / value 填充（不用 innerHTML 拼用户内容）",
    /setText\("shareTitle", post\.title \|\| ""\)/.test(appSrc) &&
    /if \(link\) link\.value = url;/.test(appSrc) &&
    !/function openShare[\s\S]{0,1600}?innerHTML/.test(appSrc),
    "openShare 里出现 innerHTML");
}

console.log("\n[8] 入口：顶部 + 文末，多入口但共用同一面板");
{
  check("顶部「分享」改为打开面板（data-share=\"open\" + data-slug）",
    /data-share="open" data-slug="\$\{escapeHtml\(slug\)\}"/.test(appSrc),
    "顶部按钮未改为打开面板");
  check("旧的 data-share=\"native\" 写法已移除",
    !/data-share="native"/.test(appSrc), "仍存在 data-share=native");
  check("旧的 sharePost 函数已移除",
    !/function sharePost\s*\(/.test(appSrc), "sharePost 仍在（重构不完整）");
  check("模板里挂上了文末入口 shareBtnsEnd",
    /const shareBtnsEnd = `/.test(appSrc) && /\$\{nav\}\$\{shareBtnsEnd\}/.test(appSrc),
    "文末入口未插入模板");
  check("文末入口的位置在 ${nav} 之后（正文读完处，而不是标题下）",
    appSrc.indexOf("${nav}${shareBtnsEnd}") > appSrc.indexOf("const shareBtnsEnd = `"),
    "插入位置异常");
  check("两个入口都调用同一个 openShare(currentPost)",
    /if \(currentPost && currentPost\.slug === slug\) openShare\(currentPost\)/.test(appSrc),
    "入口未复用同一面板");
  check("顶部「复制链接」保留直连（少一次点击）",
    /data-share="copy" data-url="\$\{escapeHtml\(shareUrl\)\}"/.test(appSrc),
    "顶部复制按钮丢失");
  check("CSS 有文末入口样式，且不重设 .share-btn 尺寸",
    /\.post-share-end\s*\{/.test(cssSrc) && !/\.post-share-end[^{]*\{[^}]*\.share-btn/.test(cssSrc),
    "文末入口样式缺失或越权重设 .share-btn");
}

console.log("\n[9] 面板内元素（封面 / 摘要 / 二维码区）");
{
  check("面板含封面缩略图与摘要节点",
    /id="shareThumb"/.test(htmlSrc) && /id="shareSum"/.test(htmlSrc),
    "缺少封面或摘要节点");
  check("封面走 safeUrl 白名单（不是直接塞 post.cover）",
    /const cover = post\.cover \? safeUrl\(post\.cover, true\) : ""/.test(appSrc),
    "封面未过 safeUrl");
  check("无封面时隐藏缩略图而不是留破图",
    /else \{ thumb\.removeAttribute\("src"\); thumb\.hidden = true; \}/.test(appSrc),
    "无封面分支不完整");
  check("每次打开先收起二维码（避免残留上一篇的码）",
    /qrWrap\.hidden = true;\s*\/\/ 每次打开先收起/.test(appSrc),
    "未重置二维码区");
  check("CSS 有面板样式与渠道配色",
    /\.share-panel\s*\{/.test(cssSrc) && /\.share-ico-wx\s*\{\s*background:\s*#07C160/.test(cssSrc),
    "面板样式缺失");
}

console.log("\n[10] 供应链：二维码库是本地冻结的干净文件");
{
  const libPath = path.join(root, "assets", "vendor", "qrcode.js");
  if (fs.existsSync(libPath)) {
    const lib = fs.readFileSync(libPath, "utf8");
    check("库内含 MIT 许可声明（来源可追溯）",
      /MIT/.test(lib) && /Kazuhiko Arase/.test(lib), "缺少许可声明");
    check("库内无 eval / new Function",
      !/\beval\s*\(/.test(lib) && !/new Function/.test(lib), "库内出现动态求值");
    check("库内无外发请求（fetch / XHR / WebSocket）",
      !/\bfetch\s*\(/.test(lib) && !/XMLHttpRequest/.test(lib) && !/WebSocket/.test(lib),
      "库内有网络请求");
    check("库不含 localStorage / document.write（无副作用）",
      !/localStorage/.test(lib) && !/document\.write/.test(lib), "库内有额外副作用");
    check("库带 UMD 导出（可在 Node 里离线回归）",
      /module\.exports\s*=\s*factory\(\)/.test(lib), "非 UMD，离线验证会失效");
  } else {
    check("二维码库存在", false, "assets/vendor/qrcode.js 缺失");
  }
}

console.log("\n[11] 面板可用性（2026-09-16 真浏览器审计后的修复项）");
{
  // ① 焦点锁：aria-modal 只是声明，浏览器不会替你把 Tab 关在面板里
  //    （实测连按 10 次落到 body、第 11 次跑到顶栏的站点名 / 主题按钮）
  const trapFn = (appSrc.match(/function trapShareFocus[\s\S]{0,900}?\n  \}/) || [""])[0];
  check("存在 trapShareFocus（Tab 在面板内回卷）",
    !!trapFn && /e\.preventDefault\(\)/.test(trapFn) && /\.focus\(\)/.test(trapFn),
    "未找到焦点锁实现");
  check("焦点锁绑在面板的 keydown 上",
    /host\.addEventListener\("keydown", trapShareFocus\)/.test(appSrc),
    "未绑定 trapShareFocus");
  check("焦点候选按「真的可见」过滤（display:none 的渠道按钮要排除）",
    /function shareFocusables[\s\S]{0,700}?getClientRects\(\)\.length > 0/.test(appSrc),
    "未按可见性过滤");
  const noBind = appSrc.replace('host.addEventListener("keydown", trapShareFocus);', "");
  check("负向自检：去掉 keydown 绑定必须判红",
    noBind !== appSrc && !/host\.addEventListener\("keydown", trapShareFocus\)/.test(noBind),
    "变异没生效，断言可能失效");

  // ② 图标字符不能并进可访问名（读屏会念「微 微信」）
  const iconSpans = [...htmlSrc.matchAll(/<span class="share-ico share-ico-[\w-]+"[^>]*>/g)].map((m) => m[0]);
  check("六个渠道图标都标了 aria-hidden",
    iconSpans.length === 6 && iconSpans.every((s) => /aria-hidden="true"/.test(s)),
    `${iconSpans.filter((s) => !/aria-hidden="true"/.test(s)).length}/${iconSpans.length} 个未标`);
  check("X 渠道补了 aria-label（可见标签只有一个字母，说不清是哪个平台）",
    /data-channel="x" aria-label="[^"]+"/.test(htmlSrc), "X 渠道没有 aria-label");

  // ③ 面板自己是滚动容器：让遮罩滚会把整块面板位移，× 跟着跑出视口（横屏实测 top:-299）
  const panelRule = (cssSrc.match(/\.share-panel\s*\{[^}]*\}/) || [""])[0];
  check("面板自己滚（overflow-y:auto），不靠遮罩滚",
    /overflow-y:\s*auto/.test(panelRule), panelRule.slice(0, 160));
  check("面板限高：100vh + 100dvh 成对声明",
    /max-height:\s*calc\(100vh - 32px\)/.test(panelRule) && /max-height:\s*calc\(100dvh - 32px\)/.test(panelRule),
    "缺限高（横屏矮屏下面板会顶出视口）");
  check("面板内的 × 用 sticky 钉住（不随内容滚走）",
    /\.share-panel\s+\.modal-close\s*\{[^}]*position:\s*sticky/.test(cssSrc), "× 未 sticky");
  check("× 的点击目标 ≥44×44（原来桌面细指针下只有 14×24）",
    /\.share-panel\s+\.modal-close\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/.test(cssSrc),
    "× 目标尺寸不足");
  const noSticky = cssSrc.replace("position: sticky; top: 8px; right: auto; z-index: 3;", "position: absolute; top: 14px; right: 16px;");
  check("负向自检：把 × 改回 absolute 必须判红",
    noSticky !== cssSrc && !/\.share-panel\s+\.modal-close\s*\{[^}]*position:\s*sticky/.test(noSticky),
    "变异没生效，断言可能失效");

  // ④ 生成二维码后必须自动滚进视野（矮屏点「微信」否则像点了没反应，实测 inView:false）
  check("二维码生成后 scrollIntoView（block:nearest，本就在视野内就不动）",
    /renderShareQr[\s\S]{0,2400}?scrollIntoView\(\{\s*block:\s*"nearest"/.test(appSrc),
    "未做二维码自动入视野");

  // ⑤ 二维码位图按物理像素整数倍出图（旧写法 147 位图拉到 CSS 160 显示 → 摩尔纹）
  const dprLine = /const dpr = Math\.min\(3, Math\.max\(1, window\.devicePixelRatio \|\| 1\)\)/.test(appSrc);
  const scaleLine = /const scale = Math\.max\(1, Math\.round\(cssSize \* dpr \/ total\)\)/.test(appSrc);
  check("二维码按 devicePixelRatio 出整数倍位图", dprLine && scaleLine,
    `dpr=${dprLine} scale=${scaleLine}`);
  check("显示尺寸写回 canvas.style（位图 ÷ dpr ⇒ 1 物理像素对 1 位图像素）",
    /canvas\.style\.width = canvas\.style\.height = \(px \/ dpr\) \+ "px"/.test(appSrc),
    "未写回显示尺寸");
  check("CSS 显示尺寸 ≥196px（长链接 41 模块 ⇒ 每模块 ≥4 CSS px）",
    /\.share-qr\s*\{[^}]*width:\s*196px/.test(cssSrc), "显示尺寸仍偏小");

  // ⑥ 渠道网格 3 列（4 列会排成 4+2 / 隐藏系统分享后 4+1，末行永远不齐）
  check("渠道网格 3 列（6 项 = 2 行 × 3）",
    /\.share-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,/.test(cssSrc), "网格不是 3 列");
  check("负向自检：改回 4 列必须判红",
    !/\.share-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,/.test(
      cssSrc.replace("grid-template-columns: repeat(3, minmax(0, 1fr))", "grid-template-columns: repeat(4, minmax(0, 1fr))")),
    "变异没生效，断言可能失效");

  // ⑦ 详情页按钮与面板统一图标语言；标签替换不能再打在按钮本身（会把图标一起抹掉）
  check("详情页分享按钮用面板同一套字母头像（不再是 emoji 📋/📤）",
    /<span class="share-ico share-ico-cp" aria-hidden="true">链<\/span><span class="share-btn-label">复制链接<\/span>/.test(appSrc) &&
    !/📋 复制链接/.test(appSrc),
    "按钮仍是 emoji 图标");
  check("「已复制」文案打在内层 .share-btn-label 上",
    /const labelEl = shareBtn\.querySelector\("\.share-btn-label"\) \|\| shareBtn/.test(appSrc) &&
    /labelEl\.textContent = "✅ 已复制"/.test(appSrc) &&
    !/shareBtn\.textContent = "✅ 已复制"/.test(appSrc),
    "仍直接改按钮 textContent");

  // ⑧ 窄屏别再重复展示摘要（用户刚把正文读完）
  check("窄屏隐藏面板里的摘要",
    /@media \(max-width: 640px\)\s*\{[\s\S]{0,240}?\.share-post-sum\s*\{\s*display:\s*none/.test(cssSrc),
    "窄屏仍占 2 行摘要");
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败项"}（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
