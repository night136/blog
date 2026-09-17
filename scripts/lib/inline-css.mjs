// 把渲染阻塞的 assets/style.css **内联进 HTML 外壳**（构建期执行）。
//
// ## 为什么要做（docs/optimization-audit-2026-09-16.md §三）
//
// `<link rel="stylesheet">` 是渲染阻塞资源：浏览器必须等它到齐才肯画第一帧。
// 实测首页「HTML 到齐 → 首绘」增量 **658ms**，而同样内容、纯内联 CSS 的 /404.html 只要 **55ms**；
// 资源时序显示 style.css 传输 32.6KB 花了 534ms，FCP 紧跟在它之后 —— 那 ~600ms 基本就是在等这一张表。
//
// ## 为什么不按常规做法（这两条本项目都试过/不能走）
//
// - 🚫 **`media="print" onload="this.media='all'"`**：小米/360 兼容模式对该切换支持不良，
//   会导致样式表**永远不生效**，页面只剩关键 CSS、布局错乱。项目已因此回滚过一次
//   （见 index.html 里那条注释、docs/first-paint.md ③）。
//   `rel="preload" onload="this.rel='stylesheet'"` 属于同一类 onload 依赖，同样不走。
// - 🚫 **拆 critical / 首绘后由 JS 注入 rest**：收益只比内联多一点点（少 ~12KB 传输），
//   却要背上 FOUC/CLS 风险，而且样式一旦要靠 JS 才能到位，脚本一挂页面就裸奔。
//
// ## 为什么内联是划算的（实测账，不是估算）
//
// 站点只有**一个 HTML 外壳**（SPA；文章页是边缘函数往同一份 index.html 里注入正文），
// 所以内联**只影响一个文件**，不会在多页面间重复膨胀。
// 本机 brotli 预算：style.css 单独传 25332 B（线上 br 实测 32579 B，CF 压缩档位更低），
// 而把它合进 HTML 后整份只涨 24272 B —— **传输字节基本持平，却少了一整个跨境往返**。
// 另外 `/` 的策略是 `max-age=0, swr=300`，重复访问走 304 复验、不传正文，所以「CSS 不能再单独缓存」
// 这件事的实际代价是：**仅在某次部署后首次回访时多下 ~26KB**。
//
// ## 顺带消掉的一类事故
//
// 旧方案靠 `assets/style.css?v=<内容哈希>` 保证「改样式用户能拿到新版」，而 HTML 外壳可能陈旧
// （max-age=0 + swr，浏览器/边缘可端着旧壳几百秒），旧壳会去要一个**已经不存在**的版本 URL。
// 内联后样式与外壳**同生共死**：壳陈旧 ⇒ 样式也一并陈旧，但永远自洽、永远不 404。
//
// ## 源码形态 vs 产物形态
//
// 仓库里的 index.html **保留 `<link>`**（源码单一事实来源仍是 assets/style.css，便于 diff、
// 便于所有 verify-*.mjs 继续读它做对比度/断点/选择器检查）。内联只发生在 build.mjs 里：
// - 本地直接开 index.html / 探针走 `--local` ⇒ 外链，行为与今天完全一致；
// - Cloudflare Pages 构建产物 ⇒ 内联，首绘不再等样式表。
// 万一构建没跑（或这段逻辑出问题），`replaced: "none"` 会让页面**优雅降级**回今天的外链行为，
// 不会变成没样式。

// ⚠️ 标记值里**不能出现 `assets/` 前缀**：build.mjs 的资源版本化正则是
// `/assets\/style(?:...)?\.css(?:\?v=...)?/g`，它会连属性值一起改写 ——
// 实测写成 data-inlined="assets/style.css" 时，第二次构建会把属性值改成
// "assets/style.css?v=xxxx"，于是本模块认不出自己上一次写下的块（replaced 变 none）、
// 连跑两次产物还不一致（这正是 verify-inline-css.mjs [2] 抓到的）。
export const INLINE_MARKER = 'data-inlined="style.css"';

// 源码形态：<link rel="stylesheet" href="assets/style.css" />（?v= 是 hashAssets 上一阶段加的）
const LINK_RE = /[ \t]*<link[^>]+href="assets\/style\.css(?:\?v=[a-z0-9]+)?"[^>]*>[ \t]*\r?\n?/;

// 产物形态：本函数上次写入的内联块（保证连跑两次幂等，且 CSS 改了能刷新）
const INLINE_RE = /<style data-inlined="style\.css">[\s\S]*?<\/style>/;

/**
 * 把 HTML 里的外链样式表替换成同位置的内联样式块。
 * @param {string} html  HTML 外壳
 * @param {string} css   assets/style.css 的**原文**（不做任何压缩/改写，避免与源码不一致）
 * @returns {{html: string, replaced: "inline"|"link"|"none"|"unsafe", reason?: string}}
 */
export function inlineStyleSheet(html, css) {
  // CSS 里若出现 </style，内联会提前闭合样式块、剩下的 CSS 会变成可见文本洒在页面上。
  // 宁可不内联（回到外链）也不能产出坏页面；返回 unsafe 由调用方响亮地记一笔。
  if (/<\/style/i.test(css)) {
    return { html, replaced: "unsafe", reason: "CSS 内含 </style，内联会提前闭合样式块" };
  }

  // 用**函数形式**做替换：CSS 里可能出现 $& / $1 这类序列（content 属性等），
  // 字符串形式会把它们当替换模式解释，把样式改坏。
  const block = `<style ${INLINE_MARKER}>\n${css}\n</style>`;

  if (INLINE_RE.test(html)) return { html: html.replace(INLINE_RE, () => block), replaced: "inline" };
  if (LINK_RE.test(html)) return { html: html.replace(LINK_RE, () => block), replaced: "link" };
  return { html, replaced: "none", reason: "HTML 里既没有 style.css 外链、也没有本函数写入过的内联块" };
}
