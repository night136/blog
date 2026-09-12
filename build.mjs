// build.mjs — 静态预渲染
// 构建时用 Cloudflare D1 REST API 拉全部文章，生成静态 JSON，供前端经 CDN 直读：
//   generated/posts.json              → 列表（不含 body）
//   generated/posts/<slug>.json       → 单篇详情（含 body）
// 容错：任何异常都不抛出，保证 Pages 部署不因构建失败而中断；前端在静态缺失时降级到 Function。
import { mkdirSync, writeFileSync, statSync, existsSync, readFileSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "generated");
const LIST_FILE = join(OUT_DIR, "posts.json");
const POST_DIR = join(OUT_DIR, "posts");
const COVER_DIR = join(OUT_DIR, "covers");
const COVER_PREFIX = "/generated/covers/"; // 封面静态文件的对外路径前缀（判断 cover 是否为本站构建产物）
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

function publicList(row) {
  const words = row.words || 0;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    date: row.date,
    tag: row.tag || "未分类",
    summary: row.summary || "",
    cover: materializeCover(row),
    author: row.author_username || "昉昕",
    readingMinutes: Math.max(1, Math.round(words / 300)),
    words,
    views: row.views || 0,
  };
}

function publicDetail(row) {
  const words = countWords(row.body);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    date: row.date,
    tag: row.tag || "未分类",
    summary: row.summary || "",
    // 详情同样抽离封面：否则同一张图会在 detail JSON 里出现两次（cover 字段一份、
    // body 正文里又内嵌一份），实测单篇详情 241KB 中有 240KB 是这张图的重复。
    cover: materializeCover(row),
    author: row.author_username || "昉昕",
    isAuthor: false, // 静态无法判断当前用户，前端打开时按会话修正
    views: row.views || 0,
    readingMinutes: Math.max(1, Math.round(words / 300)),
    words,
    body: row.body,
  };
}

// 资源内容哈希化：给 app.js / style.css / vendor/lunar.js 加「内容哈希」文件名。
// 部署后文件名随内容变化而变 → 浏览器视为全新资源自动拉取，无需手动硬刷新/清缓存。
// 失败仅 warn 不影响部署（前端仍可正常降级到未哈希的旧路径语义）。
function hashAssets() {
  const assetsDir = join(__dirname, "assets");
  // 返回「带 assets/ 前缀的相对路径」，便于直接替换 index.html 与 app.js 内部引用
  function hashCopy(relPath) {
    const abs = join(assetsDir, relPath);
    const buf = readFileSync(abs);
    const h = createHash("sha256").update(buf).digest("hex").slice(0, 10);
    const dot = relPath.lastIndexOf(".");
    const hashedRel = relPath.slice(0, dot) + "." + h + relPath.slice(dot);
    // 保留原文件作兜底，新增一份哈希副本（部署后旧哈希文件仍在 CDN，不会出现 404）
    copyFileSync(abs, join(assetsDir, hashedRel));
    return "assets/" + hashedRel;
  }
  // 1) lunar 先哈希：app.js 内部动态引用它，需先拿到哈希名
  const lunarHashed = hashCopy("vendor/lunar.js");
  // 2) app.js：把内部 lunar 引用替换为哈希名，再对自身内容哈希
  const appAbs = join(assetsDir, "app.js");
  let appSrc = readFileSync(appAbs, "utf8");
  appSrc = appSrc.split("assets/vendor/lunar.js").join(lunarHashed);
  const appH = createHash("sha256").update(appSrc).digest("hex").slice(0, 10);
  const appName = `assets/app.${appH}.js`;
  writeFileSync(join(assetsDir, `app.${appH}.js`), appSrc);
  // 3) style.css
  const styleHashed = hashCopy("style.css");
  // 4) 最后一步改写 index.html 引用（务必等上述全部成功后再动 html，避免半残状态）
  const htmlAbs = join(__dirname, "index.html");
  let html = readFileSync(htmlAbs, "utf8");
  html = html.split("assets/app.js").join(appName);
  html = html.split("assets/style.css").join(styleHashed);
  writeFileSync(htmlAbs, html);
  console.log(`[build] 资源哈希化完成 → app:${appName}, style:${styleHashed}, lunar:${lunarHashed}`);
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
  // 列表附带新鲜度元信息：静态快照无法感知数据库后续新增，前端据此校验是否过期
  // （Deploy Hook 未生效 / 部署延迟时，前端自动回退动态接口，保证发布后一定能看到）
  writeFileSync(
    LIST_FILE,
    JSON.stringify({
      ok: true,
      count: rows.length,
      latest: rows.length ? rows[0].slug : "",
      generatedAt: new Date().toISOString(),
      posts: rows.map(publicList),
    })
  );
  for (const row of rows) {
    writeFileSync(join(POST_DIR, `${row.slug}.json`), JSON.stringify({ ok: true, post: publicDetail(row) }));
  }
  // 封面映射表：与上面的文件同一次构建产出 → 表里写了哪个路径，那个文件就一定存在，天然一致。
  // 边缘函数据此给爬虫注入 og:image（D1 里存 data: base64 时爬虫抓不到，必须换成静态文件地址）。
  writeFileSync(
    COVER_MANIFEST,
    JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), covers: coverMap })
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
  if (coverIssues.length) {
    console.warn("[build] ⚠️ 封面映射表自检未通过：\n  " + coverIssues.join("\n  "));
  }
  // 输出列表体积，便于监控首屏负担（封面抽离后应从数百 KB 降到几十 KB）
  const listBytes = statSync(LIST_FILE).size;
  console.log(
    `[build] 已生成 ${rows.length} 篇文章静态 JSON → generated/；列表 posts.json = ${(listBytes / 1024).toFixed(1)}KB；` +
      `封面映射 ${Object.keys(coverMap).length} 条 → generated/covers.json`
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
