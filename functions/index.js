// 边缘函数：为爬虫做 dynamic rendering —— 注入文章专属 title / meta / 正文。
//
// 背景：本站是单页应用，文章地址形如 /?post=<slug>，页面内容全靠前端 JS 渲染。
// 但社交平台（微信/微博/X/Facebook…）和搜索引擎抓取页面时**不执行 JS**：
//   · 分享出去没有卡片（OG 原本由 JS 写进 head）；
//   · 百度/搜狗这类爬虫打开文章只能看到一个空容器，**正文一个字都抓不到** —— 文章进不了索引。
//
// 做法：爬虫请求带 ?post= 时，在边缘把三样东西内联进 index.html 再返回：
//   ① <title>（爬虫读不到 document.title；不替换的话搜索结果里每篇都显示站点名）
//   ② OG / Twitter Card / canonical / description / JSON-LD（整块替换，避免残留指向首页的 canonical）
//   ③ 文章正文（构建期预渲染的静态片段，见 generated/post-html/）
//
// ⚠️ 这不是 cloaking：注入的正文与真人看到的是**同一份内容**（同一份 markdown、同一套渲染规则，
//    scripts/verify-seo-render.mjs 会把两边输出逐条比对以防漂移），只是省掉了「必须先执行 JS」这一步。
//    真人的访问路径完全不变，前端逻辑零改动。
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

// 兜底特征词：上面那份名单是人肉维护的，总有漏网的（神马 YisouSpider、各类站长工具抓取器、
// 新兴 AI 搜索的抓取器等）。命中「明显的爬虫特征词」也走注入 ——
// 代价只是多返回几 KB 文本，收益是不会有爬虫因为不在名单里而拿不到正文。
// ⚠️ 不能用 \b 词边界：YisouSpider 这类「前一个字符也是字母」的写法里
//    "uS" 之间不构成词边界，加 \b 反而漏判。宽松匹配的代价最多是给某个
//    名字里含 bot 的客户端多注入几 KB 正文，无害；漏判则等于文章不被收录。
const BOT_FALLBACK_RE = /(bot|spider|crawler|crawl|slurp|scrapy)/i;
function isBot(ua) {
  return BOT_RE.test(ua) || BOT_FALLBACK_RE.test(ua);
}

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
// 图落成静态文件，但哈希边缘侧算不出来，所以由构建期输出映射表。
// 落点有两处：封面自成一图时是 /generated/covers/<slug哈希>-<内容哈希>.<ext>；
// 封面就是正文里的某张图时（线上 7/7 都是）直接复用 /generated/body-images/<内容哈希>.<ext>
// —— 同一个 URL，浏览器只下一次。所以下面复核存在性时**不能只放行 covers/**。
// 文件与映射表同一次构建产出，正常情况下表里有的路径文件必定存在。
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

// ── 文章正文片段（构建期产物 generated/post-html.json：slug → 片段路径）──
// 为什么正文要预渲染成静态片段，而不是在这里从 D1 拉 body 现渲染：
//   ① Pages Functions 免费版 CPU 预算只有 10ms 量级，而单篇 body 实测可达 147KB（几乎全是内嵌 base64 图），
//      在边缘做「取回 + 解码 + 替换 + 逐行渲染」很容易超预算；
//   ② 构建期产物可以直接被缓存，边缘只读一个 0.6KB 左右的片段，几乎不耗 CPU。
// 片段缺失（例如文章是构建之后才发布的）不报错，只是这一篇不注入正文、其余照常。
const POST_HTML_MANIFEST_PATH = "/generated/post-html.json";
const postHtmlManifestCache = { at: 0, data: null };

async function loadPostHtmlManifest(env, origin) {
  const now = Date.now();
  if (postHtmlManifestCache.data && now - postHtmlManifestCache.at < MANIFEST_TTL_MS) return postHtmlManifestCache.data;
  try {
    if (!env.ASSETS) return null;
    const res = await env.ASSETS.fetch(new Request(`${origin}${POST_HTML_MANIFEST_PATH}`, { method: "GET" }));
    if (!res || !res.ok) return null;
    const json = await res.json();
    const pages = json && json.pages && typeof json.pages === "object" ? json.pages : null;
    if (pages) postHtmlManifestCache.data = pages;
    if (pages) postHtmlManifestCache.at = now;
    return pages;
  } catch (_) {
    return null;
  }
}

// 片段内容在 isolate 内再缓存一层：爬虫常对同一篇反复抓取，没必要每次都走一次内部 ASSETS 往返。
const postHtmlCache = new Map();
const POST_HTML_CACHE_MAX = 64;

async function loadPostHtml(env, origin, slug) {
  const hit = postHtmlCache.get(slug);
  if (hit && Date.now() - hit.at < MANIFEST_TTL_MS) return hit.html;
  const pages = await loadPostHtmlManifest(env, origin);
  const path = pages && pages[slug];
  // 白名单校验：只接受构建期产出的那种路径（纯 ASCII、无目录穿越）。
  // 映射表本身是构建产物、可信度很高，但把「路径的来源」收窄到固定前缀仍然更稳妥。
  if (typeof path !== "string" || !/^\/generated\/post-html\/[A-Za-z0-9._-]+\.html$/.test(path) || path.includes("..")) return "";
  try {
    const res = await env.ASSETS.fetch(new Request(`${origin}${path}`, { method: "GET" }));
    if (!res || !res.ok) return "";
    const html = await res.text();
    if (postHtmlCache.size >= POST_HTML_CACHE_MAX) postHtmlCache.clear();
    postHtmlCache.set(slug, { at: Date.now(), html });
    return html;
  } catch (_) {
    return "";
  }
}

// 把文章版 title / meta / 正文注入静态壳。
// 三处注入缺一不可：只有 OG 没有 title，搜索结果里每篇都显示站点名；
// 没有正文，搜索引擎就只有标题可看 —— 这正是本次要修的问题。
function injectArticle(html, { post, slug, origin, coverUrl, bodyHtml }) {
  const title = (post.title || SITE_NAME).trim();
  const pageTitle = `${title} · ${SITE_NAME}`;
  let out = html;

  // ① <title>：爬虫不执行 JS，前端 document.title 那套对它们完全无效。
  //    替换串一律用函数返回值，避免标题里的 $& / $1 被当成替换语法解析。
  if (/<title>[\s\S]*?<\/title>/i.test(out)) {
    out = out.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${esc(pageTitle)}</title>`);
  }

  // ② OG / Twitter / canonical / description 整块替换。
  //    站点级的 canonical、description、author 都在这块**内部**（index.html 里有说明），
  //    所以整块换掉之后不会残留「指向首页的 canonical」—— 那条会让搜索引擎把文章当成首页副本。
  const block = buildTags(post, slug, origin, coverUrl);
  if (out.includes("<!--OG-DEFAULT-START-->") && out.includes("<!--OG-DEFAULT-END-->")) {
    out = out.replace(/<!--OG-DEFAULT-START-->[\s\S]*?<!--OG-DEFAULT-END-->/, () => block);
  } else {
    out = out.replace("</head>", `  ${block}\n</head>`);
  }

  // ③ 正文：塞进 #postDetail 的占位标记之间。真人访问时这里是空的，由 app.js 渲染，
  //    所以这段注入只影响爬虫，前端逻辑一行都不用改。
  if (bodyHtml && out.includes("<!--SSR-BODY-START-->") && out.includes("<!--SSR-BODY-END-->")) {
    out = out.replace(
      /<!--SSR-BODY-START-->[\s\S]*?<!--SSR-BODY-END-->/,
      () => `<!--SSR-BODY-START-->${bodyHtml}<!--SSR-BODY-END-->`
    );
  }

  return out;
}

export async function onRequestGet(ctx) {
  const { request, env, next } = ctx;

  // 只处理带 ?post= 的根路径请求
  const url = new URL(request.url);
  const slug = url.searchParams.get("post");
  if (!slug || url.pathname !== "/") return next();

  // 只处理爬虫；真人访问直接放行（避免任何额外开销）
  const ua = (request.headers.get("user-agent") || "").toLowerCase();
  if (!ua || !isBot(ua)) return next();

  try {
    const post = await loadPost(env, slug);
    if (!post) return next();

    const origin = url.origin;
    const cache = caches.default;
    const cacheKey = new Request(`${origin}/__og-cache?slug=${encodeURIComponent(slug)}`, { method: "GET" });
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        return new Response(hit.body, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "X-OG-Cache": "HIT",
            // 从缓存条目里透传，否则命中缓存时看不到「有没有注入正文」，线上排查会瞎
            "X-SSR-Body": hit.headers.get("X-SSR-Body") || "?",
          },
        });
      }
    } catch (_) {}

    // 取原始 index.html（Pages 静态资源）
    if (!env.ASSETS) return next();
    const assetRes = await env.ASSETS.fetch(new Request(`${origin}/index.html`, { method: "GET" }));
    if (!assetRes || !assetRes.ok) return next();
    const html = await assetRes.text();
    if (!html.includes("</head>")) return next();

    // 文章版 title / meta / 正文一次性注入（三处各自的理由见 injectArticle 注释）。
    // 用文章专属内容整块替换首页默认 OG，避免重复 meta 导致爬虫取错值；标记缺失时会退回插入 </head> 前。
    const coverUrl = await resolveCover(env, origin, slug, post.cover);
    const bodyHtml = await loadPostHtml(env, origin, slug);
    const injected = injectArticle(html, { post, slug, origin, coverUrl, bodyHtml });
    // 缓存里也要带上这个标记，否则命中缓存时读不到「有没有注入正文」，线上排查等于瞎
    const ssrFlag = bodyHtml ? "1" : "0";
    try {
      await cache.put(cacheKey, new Response(injected, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=600, s-maxage=600",
          "X-SSR-Body": ssrFlag,
        },
      }));
    } catch (_) {}

    return new Response(injected, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=600, s-maxage=600",
        "X-OG-Cache": "MISS",
        // 线上排查用：1 = 本篇注入了正文，0 = 只有 meta（片段缺失或文章是构建后才发布的）
        "X-SSR-Body": ssrFlag,
      },
    });
  } catch (_) {
    return next(); // 兜底：注入失败也不影响站点
  }
}
