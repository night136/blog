// 列表封面瘦身工具（供列表类接口使用；详情接口不要调用，详情需要完整封面）
//
// 背景：发布文章时若未手填封面，会从正文抽首图 —— 而正文图片常是 base64 内联的，
// 于是 cover 字段可能是一张几百 KB 的 data URI。列表接口把 11 篇文章的 cover 一并返回，
// 响应体就会膨胀到 576KB（实测 3 张封面占了 573.9KB，99.5%）。
// 更糟的是：静态快照（generated/posts.json）与动态接口（/api/posts）体积几乎一样大，
// 所以「静态加载慢 → 降级到动态」根本救不了 —— 两条路都是同一个大文件。
// 手机弱网下这个响应要 4.6s(1Mbps) ~ 9.2s(500Kbps) 才下完，期间首屏一直白屏/转圈。
//
// 策略：列表只保留 http(s) 外链封面；data: 内联图一律丢弃，
// 前端卡片用「标题哈希渐变」兜底（gradFor），封面本身在文章详情页仍会正常显示。
// 这样列表响应从几百 KB 降到几 KB，首屏秒开。
export function safeCover(c) {
  const s = (c || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s; // 外链封面体积小，正常保留
  if (s.startsWith("/")) return s;       // 站点内相对路径封面（materializeCover 产物，仅 URL 不含图本身，体积小，保留）
  return ""; // data: 等内联图不进列表
}

// ─────────────────────────────────────────────────────────────────────────────
// 构建产物封面判定：禁止把 generated/ 下的路径写回数据库
// ─────────────────────────────────────────────────────────────────────────────
// 背景（2026-09 线上事故）：build.mjs 会把 data: base64 封面抽离成静态文件
// /generated/covers/<slug哈希>-<内容哈希>.<ext>，并把**构建产物路径**写进
// generated/posts.json 与 generated/posts/<slug>.json。而编辑器是从这些快照加载文章的，
// 于是封面输入框被预填成产物路径；用户只改正文、点一下保存，D1 里的原始 cover
// （通常是 data: base64 原文）就被这条路径覆盖 —— 而 generated/ 是构建产物：
// 不入库、每次构建都可能改名甚至消失，原图就此永久丢失（无法恢复，只能重新上传）。
//
// 判定规则：站内相对路径以 /generated/ 开头；或绝对 URL 且其 pathname 以 /generated/
// 开头、且主机属于本站（请求 origin / SITE_URL）或 Cloudflare Pages/Workers 域。
// 其它站点上的 /generated/ 路径不归我们管（可能是对方 CDN 的正常资源）。
const ARTIFACT_COVER_PREFIX = "/generated/";

// ─────────────────────────────────────────────────────────────────────────────
// 列表封面的最终取值：D1 原值 + 构建产物映射表（generated/covers.json）
// ─────────────────────────────────────────────────────────────────────────────
// 与 safeCover 的分工：safeCover 只管「这条值能不能进列表」，这里管「进列表的该是哪条」。
//
// 为什么要看构建产物映射表：
//   ① D1 存 data: base64 时 safeCover 会丢弃 → 列表没有封面，而构建产物里明明有它的静态文件
//      （同一张图）。实测 16 篇里 6 篇是这种情况：静态快照有封面、API 降级路径没有，
//      同一篇文章两条路表现不一致 —— 快照一失败封面就集体消失。
//   ② D1 存 /generated/covers/… 时，那条路径未必还有效：历史构建用过「含中文 slug」的命名，
//      线上实测 404（2026-09-08-学会识痞-拒痞-治痞-hu59）。以本轮构建写出的路径为准才可靠。
// 只在上面两种情况下改用映射表；外链、以及「D1 本来就空」一律以 D1 为准 ——
// 否则用户删掉封面后，旧映射表会把已经删掉的封面又显示回来（D1 是唯一事实来源）。
export function listCover(raw, slug, covMap) {
  const v = (raw || "").trim();
  const fromManifest = (covMap && slug && covMap[slug]) || "";
  if (v.startsWith("data:")) return fromManifest;
  if (v.startsWith(ARTIFACT_COVER_PREFIX)) return fromManifest || v;
  return safeCover(v);
}

// 读构建产物封面映射表（generated/covers.json，构建时与静态快照同批产出）。
// 模块级缓存 5 分钟：列表/搜索本身还有边缘缓存，这里只是避免每次都去读一次 ASSETS。
// 读不到一律返回 null —— 调用方退回 D1 原值，接口不能因为映射表缺失而失败。
let coverMapCache = { at: 0, map: null };
export async function loadCoverMap(env, requestUrl) {
  const now = Date.now();
  if (coverMapCache.map && now - coverMapCache.at < 300000) return coverMapCache.map;
  try {
    if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== "function") return null;
    const r = await env.ASSETS.fetch(new URL("/generated/covers.json", requestUrl).toString());
    if (!r.ok) return null;
    const j = await r.json();
    const map = (j && typeof j.covers === "object" && j.covers) || null;
    if (map) coverMapCache = { at: now, map };
    return map;
  } catch (_) { return null; }
}

export function isBuildArtifactCover(raw, origin) {
  const v = String(raw == null ? "" : raw).trim();
  if (!v) return false;
  if (v.startsWith(ARTIFACT_COVER_PREFIX)) return true;
  if (!/^https?:\/\//i.test(v)) return false;
  let u;
  try { u = new URL(v); } catch (_) { return false; }
  if (!u.pathname.startsWith(ARTIFACT_COVER_PREFIX)) return false;
  const host = u.host.toLowerCase();
  if (origin) {
    try { if (host === new URL(origin).host.toLowerCase()) return true; } catch (_) {}
  }
  return /(^|\.)pages\.dev$/.test(host) || /(^|\.)workers\.dev$/.test(host);
}

// ─────────────────────────────────────────────────────────────────────────────
// 构建产物**正文图片**判定：禁止把 generated/body-images/ 路径写回数据库
// ─────────────────────────────────────────────────────────────────────────────
// 背景：和封面是同一类事故，只是对象换成了正文里内嵌的图。
// build.mjs 的 materializeBodyImages() 会把正文里的 `![](data:image/…;base64,…)`
// 抽离成静态文件并把路径写回 markdown，用于**详情快照**（否则单篇详情被 base64 撑到
// 几百 KB，实测最大 1.14MB）。而编辑器是从快照加载文章的（openCompose）——
// 于是正文框被预填成产物路径，用户只改几个字、点一下保存，D1 里的原始 data: 图片
// 就被覆盖，而 generated/ 不入库、每次构建都可能改名甚至消失 → 原图永久丢失。
// 两道防线：① 前端编辑时改从 /api/posts/detail 取**原始**正文（见 app.js openCompose）；
//           ② 这里对「正文里引用产物图片」的提交一律拒绝（见 manage.js）。
//
// 只说「图片引用」形态，不做全文 includes：本博客就写技术文章，
// 正文里完全可能出现 /generated/body-images/ 这样的路径示例（代码块里），
// 全文匹配会把它误判成事故、把作者卡在保存不了。
const ARTIFACT_BODY_IMG_RE =
  /!\[[^\]]*\]\((?:https?:\/\/[^\s)]+)?\/generated\/body-images\/|<img\b[^>]*\bsrc=["'](?:https?:\/\/[^"']+)?\/generated\/body-images\//i;

export function isBuildArtifactBody(raw) {
  return ARTIFACT_BODY_IMG_RE.test(String(raw == null ? "" : raw));
}
