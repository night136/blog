// build.mjs — 静态预渲染
// 构建时用 Cloudflare D1 REST API 拉全部文章，生成静态 JSON，供前端经 CDN 直读：
//   generated/posts.json              → 列表（不含 body）
//   generated/posts/<slug>.json       → 单篇详情（含 body）
// 容错：任何异常都不抛出，保证 Pages 部署不因构建失败而中断；前端在静态缺失时降级到 Function。
import { mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown, materializeBodyImages, buildArticleHtml, articleFileName } from "./scripts/lib/seo-render.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "generated");
const LIST_FILE = join(OUT_DIR, "posts.json");
const POST_DIR = join(OUT_DIR, "posts");
const COVER_DIR = join(OUT_DIR, "covers");
const COVER_PREFIX = "/generated/covers/"; // 封面静态文件的对外路径前缀（判断 cover 是否为本站构建产物）
// 爬虫专用的「正文 HTML 片段」产物：
//   generated/post-html/<slug哈希>.html → 文章主体（meta + 封面 + 标题 + 正文）
//   generated/post-html.json            → slug → 片段路径（边缘函数查表用）
// 为什么必须预渲染：本站是 SPA，正文靠 JS 渲染，而百度/搜狗等爬虫不执行 JS，
// 打开文章只能看到一个空容器 —— 文章根本进不了索引。边缘函数在这里只做「读片段 + 注入」，
// 不做渲染（Pages Functions 免费版 CPU 预算只有 10ms 量级，而单篇 body 可达 147KB）。
const POST_HTML_DIR = join(OUT_DIR, "post-html");
const POST_HTML_PREFIX = "/generated/post-html/";
const POST_HTML_MANIFEST = join(OUT_DIR, "post-html.json");
// 正文内嵌的 base64 图解码后的存放目录（文件名 = 内容哈希，可长缓存）
const BODY_IMG_DIR = join(OUT_DIR, "body-images");
const BODY_IMG_PREFIX = "/generated/body-images";
const postHtmlMap = {};
// slug → 对外可用的封面路径。边缘函数（functions/index.js）给爬虫注入 og:image 时需要它：
// D1 里的封面可能是 data: base64（爬虫无法引用），而抽离后的文件名含内容哈希，边缘侧算不出来。
const COVER_MANIFEST = join(OUT_DIR, "covers.json");
const coverMap = {};

const ACCOUNT = process.env.CF_ACCOUNT_ID;
const DB = process.env.CF_DATABASE_ID;
const TOKEN = process.env.CF_API_TOKEN;

// 与 functions/_lib/readingTime.js 完全一致的字数算法
function countWords(md) {
  const text = (md || "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/[#*`\[\](){}|>\-]/g, "");
  const cjkChars = (text.match(/[一-龥]/g) || []).length;
  const nonCjkWords = text
    .replace(/[一-龥]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((x) => x).length;
  return cjkChars + nonCjkWords;
}

// 列表封面抽离：
// 发布文章时若未手填封面，会从正文抽首图 —— 而正文图片常是 base64 内联的，
// 导致 cover 可能是几百 KB 的 data URI。这些 base64 全塞进 posts.json，
// 会让首屏列表 JSON 膨胀到几百 KB（实测 466KB，其中 99.5% 只是两张封面图），
// 手机弱网下首屏直接卡住/白屏。
// 做法：把 data: 封面解码写成独立图片文件，列表里只留 URL。
// 好处：列表 JSON 瘦身到几十 KB；图片可被浏览器独立缓存，不再阻塞首屏解析。
function materializeCover(row) {
  const c = (row.cover || "").trim();
  // 统一的出口：把最终对外可用的封面路径登记进映射表（og:image 注入依赖它）
  const record = (v) => {
    if (v && row.slug) coverMap[row.slug] = v;
    return v;
  };
  // 站内相对路径的 cover：若指向 /generated/covers/ 下的构建产物，必须确认文件真的存在再登记。
  // 为什么：后台编辑「回存」会把上一轮构建产出的路径写回 D1，而上一轮可能用的是别的命名
  // （历史版本文件名含非 ASCII 的 slug）。原样登记就会造出一条「表里有、文件却没有」的死链 ——
  // 线上事故（2026-09-12）：该文章的 og:image 因此指向 404，社交分享卡片是坏图。
  if (!c.startsWith("data:")) {
    if (c.startsWith(COVER_PREFIX)) {
      let ok = false;
      try {
        const rel = decodeURIComponent(c).slice(COVER_PREFIX.length);
        ok = !rel.includes("..") && existsSync(join(COVER_DIR, rel));
      } catch (_) {}
      if (!ok) {
        console.warn(`[build] ⚠️ 丢弃失效的历史封面路径（文件不存在，改用默认图）：${row.slug} -> ${c}`);
        return record("");
      }
    }
    return record(c); // http(s) 外链 / 确认存在的站内相对路径原样保留
  }
  const m = c.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/);
  if (!m) return record(""); // 非 base64（如 data:image/svg+xml,xxx）不做处理
  let buf;
  try {
    buf = Buffer.from(m[2], "base64");
  } catch (_) {
    return record("");
  }
  if (!buf.length) return record("");
  const ext = (m[1].split("/")[1] || "png").split("+")[0].replace("jpeg", "jpg");
  // 文件名必须纯 ASCII：Cloudflare Pages 对「含非 ASCII 字符的静态资源文件名」并不可靠 ——
  // 实测线上出现过「covers.json 里登记了、文件却 404」的情况（其余同批中文名文件却正常），
  // 上游同类报告见 https://github.com/solidjs/solid-start/issues/1607 。
  // 所以不再把 slug 原文写进文件名，改用 slug 的哈希做稳定前缀；
  // slug → 路径的对应关系一律走 generated/covers.json 映射表，任何一方都不需要从文件名反推 slug。
  const slugKey = createHash("sha256").update(String(row.slug || "cover")).digest("hex").slice(0, 10);
  // 内容哈希：换了封面 → 文件名就变 → 可以安全地给封面设长期 immutable 缓存，
  // 不用担心「文章内容更新了但 CDN 还在发旧封面」。
  const hash8 = createHash("sha256").update(buf).digest("hex").slice(0, 8);
  const name = `${slugKey}-${hash8}.${ext}`;
  try {
    writeFileSync(join(COVER_DIR, name), buf);
    return record(`/generated/covers/${encodeURIComponent(name)}`);
  } catch (_) {
    return record(""); // 写失败就丢掉封面，前端会用渐变色兜底，不影响列表
  }
}

function publicList(row, cover) {
  const words = row.words || 0;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    date: row.date,
    tag: row.tag || "未分类",
    summary: row.summary || "",
    cover,
    author: row.author_username || "昉昕",
    readingMinutes: Math.max(1, Math.round(words / 300)),
    words,
    views: row.views || 0,
  };
}

// bodyMd：**已抽离内嵌图片**的正文，由 materializeBodyImages() 产出。
// ⚠️ 不要改回 row.body：正文里的图常是 base64 内联的，原样写进详情会让单篇快照被撑到几百 KB。
// 线上实测（2026-09-15）：16 篇里 7 篇含内嵌图，含图文章详情平均 530KB，
// 最大一篇 1,148,543 字节；一篇正文仅 68 字的文章详情也有 151KB —— 全是那张 base64 图。
// 跨境网络下拉这个体积，表现就是「点开文章愣好几秒」。抽离后详情只剩几 KB，
// 图片走独立文件：可被浏览器长期缓存、可懒加载、也不再和正文抢同一个响应体。
// ⚠️ 随之而来的硬约束：详情里的 body 含 /generated/body-images/ 构建产物路径，
// 而编辑器会拿快照的 body 预填（openCompose）—— 所以
//   ① 前端编辑时改从 /api/posts/detail 取**原始**正文（见 app.js openCompose）；
//   ② 后端 manage.js 加了绊线：正文里出现构建产物路径直接 400。
// 丢掉这道防线就会重演「构建产物写回 D1 → 原图永久丢失」（封面那次事故 3afafdd）。
function publicDetail(row, cover, words, bodyMd) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    date: row.date,
    tag: row.tag || "未分类",
    summary: row.summary || "",
    // 详情同样抽离封面：否则同一张图会在 detail JSON 里出现两次（cover 字段一份、
    // body 正文里又内嵌一份），实测单篇详情 241KB 中有 240KB 是这张图的重复。
    cover,
    author: row.author_username || "昉昕",
    isAuthor: false, // 静态无法判断当前用户，前端打开时按会话修正
    views: row.views || 0,
    readingMinutes: Math.max(1, Math.round(words / 300)),
    words,
    body: bodyMd,
  };
}

// 资源版本化：给 app.js / style.css 的引用加 ?v=<内容哈希>（**不改文件名**）。
// 内容变 → URL 变 → 浏览器视为全新资源自动拉取，无需手动硬刷新/清缓存。
// 为什么不用「哈希文件名」：那种文件是构建产物、只存在于当次部署，而 HTML 外壳可能被
// 缓存一段时间，旧壳会引用到已删除的文件 → 404 → 整站 JS 全废（线上实测见函数内注释）。
// 失败仅 warn 不影响部署（前端仍可正常降级到未带版本的旧路径语义）。
function hashAssets() {
  const assetsDir = join(__dirname, "assets");
  const versionOf = (rel) => createHash("sha256").update(readFileSync(join(assetsDir, rel))).digest("hex").slice(0, 10);

  // ⚠️ 只改「查询串版本」，绝不改文件名 —— 线上事故（2026-09-12 实测）：
  // 原实现把 app/style 复制成带内容哈希的**新文件名**（assets/app.<hash>.js）并写进 index.html，
  // 而这类文件是 .gitignore 的构建产物、只存在于当次部署。于是任何一份陈旧 HTML
  // （/ 的策略原本是 max-age=60 + stale-while-revalidate=86400，浏览器/边缘可端着旧壳近一天）
  // 在下次部署后都会指向一个已被删除的文件 → app.js 404 → 整站 JS 全废（列表空白、骨架屏不动）。
  // 实测：不带 cache-buster 请求首页时拿到的就是引用了已删除哈希的旧壳，4/4 次 404。
  // 现在文件名固定为仓库里提交的 assets/app.js（每次部署必然存在），版本走 ?v=<内容哈希>：
  // 内容变则 URL 变、缓存自然失效；HTML 再陈旧也只会加载「上一版资源」，永远不会 404。
  // Cloudflare 的 _headers 匹配忽略查询串，所以 /assets/* 的长缓存策略依然生效（已实测）。
  const appVersion = versionOf("app.js");
  const styleVersion = versionOf("style.css");

  const htmlAbs = join(__dirname, "index.html");
  let html = readFileSync(htmlAbs, "utf8");
  // 兼容三种历史形态：仓库里的源码引用、旧实现留下的哈希文件名、本函数重跑时已带 ?v=
  html = html.replace(/assets\/app(?:\.[a-f0-9]{6,64})?\.js(?:\?v=[a-z0-9]+)?/g, `assets/app.js?v=${appVersion}`);
  html = html.replace(/assets\/style(?:\.[a-f0-9]{6,64})?\.css(?:\?v=[a-z0-9]+)?/g, `assets/style.css?v=${styleVersion}`);
  writeFileSync(htmlAbs, html);

  // 自检：HTML 里引用的站内资源（去掉查询串后）必须真实存在，防止再产出「引用了不存在文件」的壳
  const missing = [];
  for (const m of html.matchAll(/(?:src|href)="(assets\/[^"?#]+)/g)) {
    if (!existsSync(join(__dirname, m[1]))) missing.push(m[1]);
  }
  if (missing.length) {
    console.warn("[build] ⚠️ index.html 引用了不存在的资源（会导致页面直接挂掉）：\n  " + missing.join("\n  "));
  }

  console.log(`[build] 资源版本化完成 → app.js?v=${appVersion}, style.css?v=${styleVersion}（稳定文件名，不再生成哈希副本）`);
}

async function main() {
  if (!ACCOUNT || !DB || !TOKEN) {
    console.warn("[build] 未配置 CF_ACCOUNT_ID / CF_DATABASE_ID / CF_API_TOKEN，跳过静态生成；前端将降级到 Function。");
    return;
  }
  const api = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`;
  const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  async function d1(sql) {
    const r = await fetch(api, { method: "POST", headers: auth, body: JSON.stringify({ sql }) });
    const j = await r.json();
    if (!j.success) throw new Error(JSON.stringify(j.errors));
    return j.result;
  }
  const res = await d1(
    "SELECT id, slug, title, date, tag, summary, cover, author_username, views, body, words FROM posts ORDER BY date DESC, id DESC"
  );
  const rows = res[0].results;
  mkdirSync(POST_DIR, { recursive: true });
  mkdirSync(COVER_DIR, { recursive: true }); // 封面抽离目录：必须先建，materializeCover 才能写入
  mkdirSync(POST_HTML_DIR, { recursive: true });
  mkdirSync(BODY_IMG_DIR, { recursive: true });

  // 一次循环产出三类产物：列表项 / 详情 JSON / 爬虫用正文片段。
  // 合并成一个循环是为了让 materializeCover() 每篇只跑一次（它有写文件的副作用，重复调用纯属浪费）。
  const listPosts = [];
  let bodyImgCount = 0;
  let seoHtmlBytes = 0;
  for (const row of rows) {
    const cover = materializeCover(row);
    // 正文内嵌图先落成独立文件 —— **详情快照和爬虫片段都要用它**。
    // 必须在写详情 JSON 之前做：详情原先直接用 row.body，导致含图文章的详情
    // 被 base64 撑到几百 KB（实测最大 1.14MB），而抽离后只剩几 KB。
    const { markdown, saved } = materializeBodyImages(row.body || "", {
      outDir: BODY_IMG_DIR,
      urlPrefix: BODY_IMG_PREFIX,
    });
    bodyImgCount += saved.length;

    // 字数按**发布出去的正文**算：countWords 会剥掉图片 markdown，
    // 所以与按 row.body 算结果一致，但语义上更不容易出错。
    const words = countWords(markdown);
    listPosts.push(publicList(row, cover));
    writeFileSync(join(POST_DIR, `${row.slug}.json`), JSON.stringify({ ok: true, post: publicDetail(row, cover, words, markdown) }));

    const fragment = buildArticleHtml({
      title: row.title,
      tag: row.tag || "未分类",
      date: row.date,
      author: row.author_username || "昉昕",
      readingMinutes: Math.max(1, Math.round(words / 300)),
      words,
      views: row.views || 0,
      coverUrl: cover,
      bodyHtml: renderMarkdown(markdown),
    });
    const fragName = articleFileName(row.slug);
    writeFileSync(join(POST_HTML_DIR, fragName), fragment);
    seoHtmlBytes += Buffer.byteLength(fragment);
    postHtmlMap[row.slug] = `${POST_HTML_PREFIX}${fragName}`;
  }

  // 列表附带新鲜度元信息：静态快照无法感知数据库后续新增，前端据此校验是否过期
  // （Deploy Hook 未生效 / 部署延迟时，前端自动回退动态接口，保证发布后一定能看到）
  writeFileSync(
    LIST_FILE,
    JSON.stringify({
      ok: true,
      count: listPosts.length,
      latest: listPosts.length ? listPosts[0].slug : "",
      generatedAt: new Date().toISOString(),
      posts: listPosts,
    })
  );
  // 封面映射表：与上面的文件同一次构建产出 → 表里写了哪个路径，那个文件就一定存在，天然一致。
  // 边缘函数据此给爬虫注入 og:image（D1 里存 data: base64 时爬虫抓不到，必须换成静态文件地址）。
  writeFileSync(
    COVER_MANIFEST,
    JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), covers: coverMap })
  );
  // 正文片段映射表：边缘函数据此把 slug 换成片段路径 —— 与片段文件同批产出，天然一致。
  // 用映射表而不是「slug 直接拼路径」：slug 含中文，而 Pages 对非 ASCII 资源名不可靠。
  writeFileSync(
    POST_HTML_MANIFEST,
    JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), pages: postHtmlMap })
  );
  // 自检：把「表里有路径、文件却不存在」和「文件名含非 ASCII」这两类问题在构建期就喊出来。
  // 成因是真实的：线上出现过映射表登记了封面、部署里却没有该文件（Pages 对非 ASCII 资源名不可靠），
  // 结果社交卡片变成坏图。宁可构建日志里显眼，也不要让爬虫去发现。
  const coverIssues = [];
  for (const [slug, p] of Object.entries(coverMap)) {
    const decoded = decodeURIComponent(p);
    if (/[^\x20-\x7e]/.test(decoded)) coverIssues.push(`非 ASCII 文件名: ${decoded}`);
    try {
      statSync(join(__dirname, decoded.replace(/^\//, "")));
    } catch (_) {
      coverIssues.push(`映射表引用了不存在的文件: ${slug} -> ${p}`);
    }
  }
  // 正文片段同样自检：段里少了哪篇，那篇文章的正文就对爬虫隐身
  for (const [slug, p] of Object.entries(postHtmlMap)) {
    const decoded = decodeURIComponent(p);
    if (/[^\x20-\x7e]/.test(decoded)) coverIssues.push(`正文片段含非 ASCII 文件名: ${decoded}`);
    try {
      statSync(join(__dirname, decoded.replace(/^\//, "")));
    } catch (_) {
      coverIssues.push(`正文片段映射引用了不存在的文件: ${slug} -> ${p}`);
    }
  }
  if (coverIssues.length) {
    console.warn("[build] ⚠️ 封面映射表自检未通过：\n  " + coverIssues.join("\n  "));
  }
  // 输出列表体积，便于监控首屏负担（封面抽离后应从数百 KB 降到几十 KB）
  const listBytes = statSync(LIST_FILE).size;
  console.log(
    `[build] 已生成 ${rows.length} 篇文章静态 JSON → generated/；列表 posts.json = ${(listBytes / 1024).toFixed(1)}KB；` +
      `封面映射 ${Object.keys(coverMap).length} 条 → generated/covers.json`
  );
  console.log(
    `[build] 爬虫用正文片段 ${Object.keys(postHtmlMap).length} 篇 → generated/post-html/；` +
      `合计 ${(seoHtmlBytes / 1024).toFixed(1)}KB（平均 ${(seoHtmlBytes / 1024 / Math.max(1, rows.length)).toFixed(1)}KB/篇）；` +
      `正文内嵌图落盘 ${bodyImgCount} 张 → generated/body-images/`
  );
}

main()
  .catch((e) => {
    // 构建失败不应中断部署：前端会降级到 Function
    console.warn("[build] 静态生成失败，已忽略（前端降级到 Function）：", e && e.message ? e.message : e);
  })
  .finally(() => {
    // 资源哈希化独立于静态 JSON：无论 D1 是否可用都执行，失败仅 warn 不影响部署。
    // 放在 finally，保证「Deploy latest」每次都重新计算哈希、产出带新文件名的 index.html。
    try {
      hashAssets();
    } catch (e) {
      console.warn("[build] 资源哈希化失败(已忽略)：", e && e.message ? e.message : e);
    }
  });
