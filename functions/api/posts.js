// POST /api/posts — 会员发文章（写入 GitHub 仓库 content/posts/）
import { verifyJWT, getCookie, json } from "./_lib/auth.js";

export async function onRequestPost({ request, env }) {
  // 1. 验证会话
  const token = getCookie(request, "auth");
  let username;
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET);
    username = payload.username;
  } catch (e) {
    return json({ ok: false, error: "请先登录" }, 401);
  }

  // 2. 检查 GITHUB_TOKEN 是否配置
  if (!env.GITHUB_TOKEN) {
    return json({ ok: false, error: "服务端未配置 GITHUB_TOKEN 密钥，请联系站长。" }, 500);
  }

  // 3. 解析并校验请求体
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "请求格式错误" }, 400);
  }

  const title = (body.title || "").trim();
  const tag = (body.tag || "未分类").trim();
  const summary = (body.summary || "").trim();
  const cover = (body.cover || "").trim();
  const mdBody = (body.body || "").trim();

  if (!title) return json({ ok: false, error: "标题不能为空" }, 400);
  if (title.length > 120) return json({ ok: false, error: "标题过长（最多 120 字）" }, 400);
  if (!mdBody) return json({ ok: false, error: "正文不能为空" }, 400);
  if (mdBody.length > 50000) return json({ ok: false, error: "正文过长（最多 50000 字）" }, 400);

  // 4. 生成安全的文件名（日期 + 标题 slug + 短哈希防碰撞）
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  // 标题 -> slug：去标点、空格换横线、最多 40 字符
  const slug = title
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    || "untitled";

  // 短哈希避免重名（取时间戳末 6 位 hex）
  const shortHash = parseInt(String(Date.now() % 1000000)).toString(36);
  const fileName = `${date}-${slug}-${shortHash}.md`;

  // 5. 组装 Markdown（frontmatter + 正文）
  const frontmatter = [
    "---",
    `title: "${title.replace(/"/g, '\\"')}"`,
    `date: ${date}`,
    `tag: ${tag}`,
    `author: ${username}`,
    summary && summary.length <= 200 ? `summary: "${summary.replace(/"/g, '\\"')}"` : "",
    cover && /^https?:\/\/.+\.(png|jpg|jpeg|gif|webp|svg)(\?.*)?$/i.test(cover) ? `cover: ${cover}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const mdContent = `${frontmatter}\n---\n\n${mdBody}\n`;

  // 6. 调 GitHub Contents API 写入文件
  const repo = "night136/blog";
  const branch = "main";
  const apiPath = `https://api.github.com/repos/${repo}/contents/content/posts/${encodeURIComponent(fileName)}`;

  const ghBody = {
    message: `发布文章: ${title}`,
    content: btoa(unescape(encodeURIComponent(mdContent))),
    branch,
  };

  // 先检查是否已存在同名文件（冲突概率极低，但做一下）
  try {
    const check = await fetch(apiPath, {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    });
    if (check.ok) {
      const ex = await check.json();
      ghBody.sha = ex.sha;
    }
  } catch (e) { /* 不存在，正常 */ }

  try {
    const res = await fetch(apiPath, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(ghBody),
    });

    if (!res.ok) {
      const err = await res.text();
      return json({ ok: false, error: `GitHub 写入失败：${res.status}` }, 500);
    }

    const result = await res.json();
    return json({
      ok: true,
      file: fileName,
      url: result.content.html_url,
      message: "文章已发布！1–2 分钟后刷新首页即可看到。",
    });
  } catch (e) {
    return json({ ok: false, error: "网络错误，发布失败" }, 500);
  }
}
