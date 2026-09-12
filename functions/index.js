// 边缘函数：为社交平台 / 搜索引擎爬虫注入文章专属 OG 标签（dynamic rendering）
//
// 背景：本站是单页应用，文章地址形如 /?post=<slug>，OG 标签原本由前端 JS 动态写入 head。
// 但社交平台（微信/微博/X/Facebook…）和搜索引擎抓取页面时**不执行 JS**，
// 只能看到 index.html 里的初始标签 —— 于是分享出去没有卡片，或永远是全站同一张。
//
// 做法：爬虫请求带 ?post= 时，在边缘读取文章数据，把 OG / Twitter Card / JSON-LD
// 直接内联进 index.html 再返回。正文内容不变（不是 cloaking），只是补上元信息。
//
// 封面：D1 里的 cover 可能是 data: base64（爬虫无法引用），构建期已由 build.mjs 抽离成
// 静态文件并输出 generated/covers.json（slug → 路径）。这里查表换成绝对 URL 作为 og:image；
// 查不到（外链/相对路径仍可直用，data: 则）退回全站默认图。
//
// 安全设计：任何一步失败（无数据库、文章不存在、ASSETS 不可用、HTML 结构异常）
// 都直接 next() 回退到原来的静态响应，绝不影响正常访问。

const SITE_NAME = "昉昕的博客";
const DEFAULT_DESC = "记录技术实践、读书笔记与生活思考。";
const DEFAULT_IMAGE = "/assets/og-default.png";

// 社交平台 + 搜索引擎爬虫（小写匹配）
const BOT_RE =
  /facebookexternalhit|facebot|twitterbot|xing-contenttabreceiver|linkedinbot|slackbot|slackbot-linkexpanding|telegrambot|whatsapp|discordbot|viber|skypeuripreview|micromessenger|weibo|qq\/|qzone|baiduspider|googlebot|google-inspectiontool|bingbot|msnbot|yandexbot|applebot|duckduckbot|sogou|360spider|haosouspider|bytespider|petalbot|semrushbot|ahrefsbot|embedly|quora link preview|pinterest|redditbot|outbrain/i;

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 去掉 Markdown 标记，生成给 OG 用的纯文本摘要
function plainText(md) {
  return String(md || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// 读取文章。posts 表可能缺 cover/views 列（旧库未迁移），逐级降级。
async function loadPost(env, slug) {
  if (!env.BLOG_DB || !slug) return null;
  const queries = [
    "SELECT title, date, tag, summary, cover, author_username FROM posts WHERE slug = ?",
    "SELECT title, date, tag, summary, author_username FROM posts WHERE slug = ?",
    "SELECT title, date, tag, summary FROM posts WHERE slug = ?",
  ];
  for (const q of queries) {
    try {
      const row = await env.BLOG_DB.prepare(q).bind(slug).first();
      if (row) return row;
    } catch (e) {
      const msg = (e && e.message) || "";
      if (!/no such column/i.test(msg)) break; // 非"缺列"错误就不再重试
    }
  }
  return null;
}

// 封面映射表（构建期产物 generated/covers.json：slug → 可直接对外引用的封面路径）。
// 为什么需要它：D1 里后台上传的封面存的是 data: base64，爬虫无法引用；build.mjs 会把这些
// 图落成 /generated/covers/<slug哈希>-<内容哈希>.<ext> 静态文件，但哈希边缘侧算不出来，
// 所以由构建期输出映射表。文件与映射表同一次构建产出，正常情况下表里有的路径文件必定存在。
const COVER_MANIFEST_PATH = "/generated/covers.json";
const MANIFEST_TTL_MS = 5 * 60 * 1000;
let manifestCache = { at: 0, data: null };

// 静态资源存在性复核（同一 isolate 内缓存 5 分钟）。
// 为什么还要复核：映射表与文件虽是同一次构建产出，但「构建产物 → 边缘上传」这一步并非绝对可靠
// （实测出现过映射表里有、线上却 404）。一旦把 404 的地址写进 og:image，社交卡片就是坏图，
// 而且会被 caches.default 缓存 10 分钟。这里花一次内部 ASSETS 读换取「绝不指错图」。
const existsCache = new Map();
const EXISTS_TTL_MS = 5 * 60 * 1000;
const EXISTS_MAX = 512;

async function assetExists(env, origin, pathname) {
  if (!env.ASSETS || !pathname) return true; // 无法复核时不阻断（宁可相信映射表）
  const now = Date.now();
  const hit = existsCache.get(pathname);
  if (hit && now - hit.at < EXISTS_TTL_MS) return hit.ok;
  let ok = true; // 复核本身出错时按「存在」处理，退回旧行为而不是误判成无封面
  try {
    const res = await env.ASSETS.fetch(new Request(`${origin}${pathname}`, { method: "GET" }));
    ok = res.status !== 404; // 只有明确的 404 才算缺失，5xx 等瞬态错误不降级
    try { if (res.body) await res.body.cancel(); } catch (_) {}
  } catch (_) {
    ok = true;
  }
  if (existsCache.size >= EXISTS_MAX) existsCache.clear();
  existsCache.set(pathname, { at: now, ok });
  return ok;
}

async function loadCoverManifest(env, origin) {
  const now = Date.now();
  if (manifestCache.data && now - manifestCache.at < MANIFEST_TTL_MS) return manifestCache.data;
  try {
    if (!env.ASSETS) return null;
    const res = await env.ASSETS.fetch(new Request(`${origin}${COVER_MANIFEST_PATH}`, { method: "GET" }));
    if (!res || !res.ok) return null;
    const json = await res.json();
    const covers = json && json.covers && typeof json.covers === "object" ? json.covers : null;
    if (covers) manifestCache = { at: now, data: covers }; // 同一 isolate 内复用，避免每次请求都取
    return covers;
  } catch (_) {
    return null;
  }
}

// 把 D1 里的 cover 解析成爬虫可直接抓取的绝对 URL；解析不出来时返回 ""（调用方用默认图兜底）。
async function resolveCover(env, origin, slug, raw) {
  const c = String(raw || "").trim();
  const manifest = await loadCoverManifest(env, origin);
  const mapped = manifest && manifest[slug];

  // 站内地址一律复核文件真的在（同一 isolate 内缓存）。
  // 宁可退回默认图，也不要把 404 地址写进 og:image —— 坏图会被社交平台与 caches.default 长期缓存。
  // 只放行 http(s)；跨域外链不复核，避免为别人的图多打一次外部请求。
  const accept = async (p) => {
    let u = null;
    try { u = new URL(p, origin); } catch (_) { return ""; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (u.origin !== origin) return u.toString();
    return (await assetExists(env, origin, u.pathname)) ? u.toString() : "";
  };

  // 1) 映射表优先（构建期与封面文件同批产出）
  if (mapped) {
    const abs = await accept(mapped);
    if (abs) return abs;
  }
  // 2) 外链直接用（D1 里本就是 http(s) 封面）
  if (/^https?:\/\//i.test(c)) return c;
  // 3) 站内相对路径兜底。
  //    ⚠️ 这里必须同样做存在性复核。线上事故（2026-09-12）：映射表里登记的是失效路径，
  //    而 D1 的 cover 也被后台回存成了同一条失效路径；旧代码在复核失败后立刻把这条路径
  //    原样返回，等于复核白做 —— og:image 依旧指向 404，分享卡片是坏图。
  if (c.startsWith("/")) return await accept(c);
  return "";
}

function buildTags(post, slug, origin, coverUrl) {
  const title = (post.title || SITE_NAME).trim();
  const author = (post.author_username || "昉昕").trim();
  const summary = plainText(post.summary).slice(0, 160);
  const desc = summary || DEFAULT_DESC;
  const canonical = `${origin}/?post=${encodeURIComponent(slug)}`;
  // coverUrl 由 resolveCover() 解析（已保证是绝对 URL）；空则用全站默认图
  const defaultImage = new URL(DEFAULT_IMAGE, origin).toString();
  const image = coverUrl || defaultImage;
  const isLarge = !!image;
  // 默认图尺寸已知，补上宽高（社媒据此提前排版）；真实封面尺寸不定，交给爬虫自行抓取
  const isDefault = image === defaultImage;

  const og = [
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="${esc(SITE_NAME)}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(desc)}" />`,
    `<meta property="og:url" content="${esc(canonical)}" />`,
    `<meta property="og:image" content="${esc(image)}" />`,
    isDefault ? `<meta property="og:image:width" content="1200" />` : "",
    isDefault ? `<meta property="og:image:height" content="630" />` : "",
    `<meta property="og:image:alt" content="${esc(title)}" />`,
    `<meta property="og:locale" content="zh_CN" />`,
    post.date ? `<meta property="article:published_time" content="${esc(post.date)}" />` : "",
    post.tag ? `<meta property="article:tag" content="${esc(post.tag)}" />` : "",
    `<meta name="author" content="${esc(author)}" />`,
    `<meta name="description" content="${esc(desc)}" />`,
    `<link rel="canonical" href="${esc(canonical)}" />`,
    // Twitter / X
    `<meta name="twitter:card" content="${isLarge ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:site" content="@fangxin_blog" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(desc)}" />`,
    `<meta name="twitter:image" content="${esc(image)}" />`,
    // 微信 / 微博 额外认这组 itemprop
    `<meta itemprop="name" content="${esc(title)}" />`,
    `<meta itemprop="image" content="${esc(image)}" />`,
    `<meta itemprop="description" content="${esc(desc)}" />`,
  ].filter(Boolean).join("\n  ");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: title,
    description: desc,
    image: [image],
    url: canonical,
    datePublished: post.date || undefined,
    articleSection: post.tag || undefined,
    author: { "@type": "Person", name: author },
    publisher: { "@type": "Organization", name: SITE_NAME },
    inLanguage: "zh-CN",
  };

  return `${og}\n  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`;
}

export async function onRequestGet(ctx) {
  const { request, env, next } = ctx;

  // 只处理带 ?post= 的根路径请求
  const url = new URL(request.url);
  const slug = url.searchParams.get("post");
  if (!slug || url.pathname !== "/") return next();

  // 只处理爬虫；真人访问直接放行（避免任何额外开销）
  const ua = (request.headers.get("user-agent") || "").toLowerCase();
  if (!ua || !BOT_RE.test(ua)) return next();

  try {
    const post = await loadPost(env, slug);
    if (!post) return next();

    const origin = url.origin;
    const cache = caches.default;
    const cacheKey = new Request(`${origin}/__og-cache?slug=${encodeURIComponent(slug)}`, { method: "GET" });
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return new Response(hit.body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "X-OG-Cache": "HIT" } });
    } catch (_) {}

    // 取原始 index.html（Pages 静态资源）
    if (!env.ASSETS) return next();
    const assetRes = await env.ASSETS.fetch(new Request(`${origin}/index.html`, { method: "GET" }));
    if (!assetRes || !assetRes.ok) return next();
    const html = await assetRes.text();
    if (!html.includes("</head>")) return next();

    // 用文章专属 OG 整块替换首页默认 OG（避免重复 meta 导致爬虫取错值）。
    // 若标记缺失则退回「插入到 </head> 前」，保证任何情况下都能注入。
    const block = buildTags(post, slug, origin, await resolveCover(env, origin, slug, post.cover));
    let injected = html;
    if (html.includes("<!--OG-DEFAULT-START-->") && html.includes("<!--OG-DEFAULT-END-->")) {
      injected = html.replace(/<!--OG-DEFAULT-START-->[\s\S]*?<!--OG-DEFAULT-END-->/, () => block);
    } else {
      injected = html.replace("</head>", `  ${block}\n</head>`);
    }
    try {
      await cache.put(cacheKey, new Response(injected, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=600, s-maxage=600" },
      }));
    } catch (_) {}

    return new Response(injected, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=600, s-maxage=600",
        "X-OG-Cache": "MISS",
      },
    });
  } catch (_) {
    return next(); // 兜底：注入失败也不影响站点
  }
}
