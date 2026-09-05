// /api/posts
//   GET  : 列出全部文章（按 date desc）——供前台首页/归档/会员视图直接 fetch
//   POST : 会员发文章（验证 JWT → 写入 posts 表）
import { verifyJWT, getCookie, json, jwtSecret } from "./_lib/auth.js";
import { readingTime } from "../_lib/readingTime.js";
import { safeCover } from "../_lib/cover.js";

const MAX_TITLE = 120;
// 正文允许嵌 base64 图片：D1 单行上限 2,000,000 字节，正文留 1.9MB 余量（其他列也占空间）
const MAX_BODY = 1900000;
const MAX_TAG = 30;
const MAX_SUMMARY = 200;
// 封面可能是 base64 长串（正文首图自动当封面），放宽上限；单行总上限 2MB 由 D1 兜底
const MAX_COVER = 1900000;

function safeSlug(title) {
  return (
    title
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "untitled"
  );
}

function todayStr() {
  const n = new Date();
  const pad = (x) => String(x).padStart(2, "0");
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

function publicPost(row) {
  // 列表接口读取预存的 words 列（发布/更新时已算好写入 D1），不再 SELECT body，
  // 避免把每篇文章的 base64 图片从数据库搬出来，首页加载大幅提速
  const words = row.words || 0;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    date: row.date,
    tag: row.tag || "未分类",
    summary: row.summary || "",
    // 列表封面瘦身：data: 内联封面会让列表响应膨胀到 576KB（实测 99.5% 是 3 张 base64 图），
    // 手机弱网首屏要等 4.6~9.2s。列表丢弃内联封面，前端用标题哈希渐变兜底；
    // 封面在文章详情页仍会正常显示。详见 _lib/cover.js
    cover: safeCover(row.cover),
    author: row.author_username || "昉昕",
    readingMinutes: Math.max(1, Math.round(words / 300)),
    words,
    views: row.views || 0,
  };
}

export async function onRequestGet({ env, request }) {
  if (!env.BLOG_DB) return json({ error: "服务端未配置数据库" }, 500);
  // 边缘缓存：Pages Functions 不会因 s-maxage 标头自动走 CDN 缓存，必须用 Cache API 显式存边缘。
  // 列表为公开只读数据，缓存 60s，期间所有访客（含不同设备/网络）直接从 Cloudflare 边缘秒回，
  // 不再每次打 D1 + 触发函数冷启动（实测冷启动 1.5–2.5s）。发布/更新文章后 60s 内自动生效。
  const cache = caches.default;
  const cacheKey = new Request(request.url);
  try {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  } catch (_) { /* Cache API 不可用时降级为直连 D1 */ }

  try {
    // 关键优化：列表只 SELECT 文本列，绝不 SELECT body（body 含 base64 图片，单篇可达 1.9MB，
    // 首页若读取会把所有文章的 base64 一并从 D1 搬出，严重拖慢）。字数 words 在发布/更新时已算好存入。
    // 列缺失则逐级降级，兼容未执行迁移的库（words/views 默认 0），且任何分支都不读 body。
    const COLS_FULL = "id, slug, title, date, tag, summary, cover, author_username, views, words";
    const COLS_NO_WORDS = "id, slug, title, date, tag, summary, cover, author_username, views";
    const COLS_BASE = "id, slug, title, date, tag, summary, cover, author_username";
    let results;
    try {
      ({ results } = await env.BLOG_DB.prepare(
        `SELECT ${COLS_FULL} FROM posts ORDER BY date DESC, id DESC`
      ).all());
    } catch (e) {
      const msg = (e && e.message) ? e.message : "";
      if (/no such column: words/i.test(msg)) {
        ({ results } = await env.BLOG_DB.prepare(
          `SELECT ${COLS_NO_WORDS} FROM posts ORDER BY date DESC, id DESC`
        ).all());
        results.forEach((row) => { row.words = 0; });
      } else if (/no such column: views/i.test(msg)) {
        ({ results } = await env.BLOG_DB.prepare(
          `SELECT ${COLS_BASE} FROM posts ORDER BY date DESC, id DESC`
        ).all());
        results.forEach((row) => { row.views = 0; row.words = 0; });
      } else throw e;
    }
    const body = JSON.stringify({ ok: true, posts: results.map(publicPost) });
    const response = new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60, s-maxage=60",
      },
    });
    // 写入边缘缓存（克隆，因为 response 正文只能消费一次）
    try { await cache.put(cacheKey, response.clone()); } catch (_) {}
    return response;
  } catch (e) {
    return json({ error: "读取失败：" + (e && e.message ? e.message : e) }, 500);
  }
}

// 发布/更新/删除成功后触发 Cloudflare Pages 重新构建，使静态预渲染文件（generated/）重生成。
// Deploy Hook URL 存于 Functions 环境变量 DEPLOY_HOOK_URL，不暴露给前端。
//
// ⚠️ 关键坑：Workers / Pages Functions 在 Response 返回后会立即取消所有未完成的 fetch。
// 裸 fire-and-forget（既不 await、也不用 waitUntil）的调用根本发不出去 —— Deploy Hook 从未被
// 真正触发，静态快照（generated/）永远不刷新，表现为「发布文章后首页不显示」。
// 必须用 ctx.waitUntil() 告知运行时：响应返回后仍继续等待该 Promise 完成。
async function triggerRedeploy(env, ctx) {
  const url = env && env.DEPLOY_HOOK_URL;
  if (!url) return;
  const p = fetch(url, { method: "POST" })
    .then((r) => console.log("[redeploy] hook HTTP " + r.status))
    .catch((e) => console.log("[redeploy] hook 失败: " + ((e && e.message) || e)));
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
  else { try { await p; } catch (_) {} } // 兜底：无 waitUntil 时阻塞等待，确保 Hook 真的发出
}

export async function onRequestPost(ctx) {
  const { request, env } = ctx;
  // 1. 验证会话
  const token = getCookie(request, "auth");
  let username;
  try {
    const payload = await verifyJWT(token, jwtSecret(env));
    username = payload.username || payload.sub || payload.name;
  } catch (e) {
    return json({ ok: false, error: "请先登录" }, 401);
  }
  if (!username) return json({ ok: false, error: "会话无效" }, 401);
  if (!env.BLOG_DB) return json({ ok: false, error: "服务端未配置数据库" }, 500);

  // 2. 解析与校验
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "请求格式错误" }, 400);
  }
  const title = (body.title || "").trim();
  const tag = (body.tag || "未分类").trim().slice(0, MAX_TAG) || "未分类";
  const summary = (body.summary || "").trim().slice(0, MAX_SUMMARY);
  const coverInput = (body.cover || "").trim().slice(0, MAX_COVER);
  const mdBody = (body.body || "").trim();

  if (!title) return json({ ok: false, error: "标题不能为空" }, 400);
  if (title.length > MAX_TITLE) return json({ ok: false, error: "标题过长（最多 120 字）" }, 400);
  if (!mdBody) return json({ ok: false, error: "正文不能为空" }, 400);
  if (mdBody.length > MAX_BODY) return json({ ok: false, error: "正文过长（图片较多时请减少，单篇上限约 1.9MB）" }, 400);

  // 未手动填封面 → 从正文抽第一张图当封面（支持 data: 与 http(s) 链接）
  let cover = coverInput;
  if (!cover) {
    const m = mdBody.match(/!\[[^\]]*\]\(([^)\s]+)\)/);
    if (m) cover = m[1].slice(0, MAX_COVER);
  }

  // 3. 生成 slug（日期 - 标题 - 短哈希防重名）
  const date = todayStr();
  const slug = `${date}-${safeSlug(title)}-${parseInt(String(Date.now() % 1000000)).toString(36)}`;

  // 4. 写入 D1
  try {
    const { words } = readingTime(mdBody);
    await env.BLOG_DB.prepare(
      `INSERT INTO posts (slug, title, date, tag, summary, cover, author_username, body, words)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        slug,
        title,
        date,
        tag,
        summary || null,
        cover || null,
        username,
        mdBody,
        words
      )
      .run();
  } catch (e) {
    return json({ ok: false, error: "写入失败：" + (e && e.message ? e.message : e) }, 500);
  }

  await triggerRedeploy(env, ctx); // 重新生成静态预渲染文件
  return json({ ok: true, slug, message: "文章已发布！刷新首页即可看到。" });
}