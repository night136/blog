// /api/guestbook/manage
//   留言墙管理接口 —— 仅站长（BLOG_OWNER）可删除便签
import { json, verifyJWT, getCookie, isOwner, jwtSecret } from "../_lib/auth.js";

export async function onRequestPost({ request, env }) {
  if (!env.BLOG_DB) return json({ ok: false, error: "服务端未配置数据库" }, 500);

  let body;
  try { body = await request.json(); } catch (_) {
    return json({ ok: false, error: "请求格式错误" }, 400);
  }

  const id = Number(body.id);
  if (!id) return json({ ok: false, error: "缺少便签 id" }, 400);

  // 站长鉴权
  const token = getCookie(request, "auth");
  let username = null;
  if (token) {
    try {
      const p = await verifyJWT(token, jwtSecret(env));
      username = p.username || p.sub || p.name || null;
    } catch (_) {}
  }
  if (!isOwner(username, env)) {
    return json({ ok: false, error: "只有站长可以删除便签" }, 403);
  }

  try {
    const { meta } = await env.BLOG_DB.prepare(
      "DELETE FROM guestbook_notes WHERE id = ?"
    ).bind(id).run();
    if (!meta || meta.changes === 0) return json({ ok: false, error: "便签不存在" }, 404);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: "删除失败：" + (e && e.message ? e.message : e) }, 500);
  }
}