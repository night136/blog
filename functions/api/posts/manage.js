// /api/posts/manage
// 文章管理统一入口（POST body 传 slug，避免国产浏览器对 URL 中文 slug 的编码损坏）
//   action: "update" → 更新文章（仅作者）
//   action: "delete" → 删除文章（仅作者）
import { verifyJWT, getCookie, json } from "../_lib/auth.js";

const MAX_TITLE = 120;
const MAX_BODY = 1900000;
const MAX_TAG = 30;
const MAX_SUMMARY = 200;
const MAX_COVER = 1900000;

function unauthorized() {
  return json({ ok: false, error: "请先登录" }, 401);
}

async function getUsername(request, env) {
  const token = getCookie(request, "auth");
  if (!token) return null;
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET);
    return payload.username || payload.sub || payload.name;
  } catch (e) { return null; }
}

export async function onRequestPost({ request, env }) {
  if (!env.BLOG_DB) return json({ ok: false, error: "服务端未配置数据库" }, 500);

  const username = await getUsername(request, env);
  if (!username) return unauthorized();

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "请求格式错误" }, 400); }
  const action = (body.action || "").toString();
  const slug = (body.slug || "").toString();
  if (!slug) return json({ ok: false, error: "缺少 slug" }, 400);

  // 校验作者身份
  const row = await env.BLOG_DB.prepare(
    "SELECT author_username FROM posts WHERE slug = ?"
  ).bind(slug).first();
  if (!row) return json({ ok: false, error: "文章不存在" }, 404);
  if (row.author_username !== username) return json({ ok: false, error: "只能操作自己写的文章" }, 403);

  if (action === "delete") {
    try {
      await env.BLOG_DB.prepare("DELETE FROM posts WHERE slug = ?").bind(slug).run();
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: "删除失败：" + (e && e.message ? e.message : e) }, 500);
    }
  }

  if (action === "update") {
    const title = (body.title || "").trim();
    const tag = (body.tag || "未分类").trim().slice(0, MAX_TAG) || "未分类";
    const summary = (body.summary || "").trim().slice(0, MAX_SUMMARY);
    const coverInput = (body.cover || "").trim().slice(0, MAX_COVER);
    const mdBody = (body.body || "").trim();

    if (!title) return json({ ok: false, error: "标题不能为空" }, 400);
    if (title.length > MAX_TITLE) return json({ ok: false, error: "标题过长（最多 120 字）" }, 400);
    if (!mdBody) return json({ ok: false, error: "正文不能为空" }, 400);
    if (mdBody.length > MAX_BODY) return json({ ok: false, error: "正文过长（图片较多时请减少，单篇上限约 1.9MB）" }, 400);

    let cover = coverInput;
    if (!cover) {
      const m = mdBody.match(/!\[[^\]]*\]\(([^)\s]+)\)/);
      if (m) cover = m[1].slice(0, MAX_COVER);
    }

    try {
      const { words } = readingTime(mdBody);
      await env.BLOG_DB.prepare(
        `UPDATE posts SET title = ?, tag = ?, summary = ?, cover = ?, body = ?, words = ? WHERE slug = ?`
      ).bind(title, tag, summary || null, cover || null, mdBody, words, slug).run();
      return json({ ok: true, slug });
    } catch (e) {
      return json({ ok: false, error: "更新失败：" + (e && e.message ? e.message : e) }, 500);
    }
  }

  return json({ ok: false, error: "未知操作" }, 400);
}
