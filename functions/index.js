// 边缘函数：为社交平台 / 搜索引擎爬虫注入文章专属 OG 标签（dynamic rendering）
//
// 背景：本站是单页应用，文章地址形如 /?post=<slug>，OG 标签原本由前端 JS 动态写入 head。
// 但社交平台（微信/微博/X/Facebook…）和搜索引擎抓取页面时**不执行 JS**，
// 只能看到 index.html 里的初始标签 —— 于是分享出去没有卡片，或永远是全站同一张。
//
// 做法：爬虫请求带 ?post= 时，在边缘读取文章数据，把 OG / Twitter Card / JSON-LD
// 直接内联进 index.html 再返回。正文内容不变（不是 cloaking），只是补上元信息。
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

function buildTags(post, slug, origin) {
  const title = (post.title || SITE_NAME).trim();
  const author = (post.author_username || "昉昕").trim();
  const summary = plainText(post.summary).slice(0, 160);
  const desc = summary || DEFAULT_DESC;
  const canonical = `${origin}/?post=${encodeURIComponent(slug)}`;
  const image = post.cover && /^https?:\/\//i.test(post.cover)
    ? post.cover
    : new URL(DEFAULT_IMAGE, origin).toString();
  const isLarge = !!image;

  const og = [
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="${esc(SITE_NAME)}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(desc)}" />`,
    `<meta property="og:url" content="${esc(canonical)}" />`,
    `<meta property="og:image" content="${esc(image)}" />`,
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
    const block = buildTags(post, slug, origin);
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
