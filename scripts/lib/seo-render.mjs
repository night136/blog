// 构建期把文章正文渲染成「爬虫可直接读到」的 HTML 片段。
//
// 为什么放在构建期而不是边缘函数：
//   Pages Functions 免费版 CPU 预算很紧（10ms 量级），而正文常内嵌 base64 大图
//   （实测单篇 body 达 147KB，其中 99% 是 base64）。在边缘做「解码 + 解码后替换 + 逐行渲染」
//   既容易超预算，也要把整段 base64 拉进 Worker 内存。构建期没有这些限制，
//   产物天然可缓存，边缘只需读一个几 KB 的静态片段。
//
// ⚠️ 渲染规则必须与 assets/app.js 的 mdToHtml() / safeUrl() 保持一致。
//   两边输出不同 = 爬虫看到的正文和真人看到的不一样，既可能被判定 cloaking，
//   也让「收录正文」这件事失去意义。scripts/verify-seo-render.mjs 会从 app.js 里
//   截取这两个函数，拿同一组 markdown 与本模块逐条比对输出，防止日后悄悄漂移。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// URL 协议白名单：默认只放行 http/https/mailto/tel 与站内相对路径。
// 图片额外允许 data:image 位图（**不含** svg+xml —— svg 可携带脚本）。
// 与 app.js 的 safeUrl() 同规则；传入的已是转义后字符串，这里只做协议判定。
export function safeUrl(raw, allowDataImage) {
  let url = String(raw == null ? "" : raw).trim();
  // 剔除控制字符/换行，避免 "java\nscript:" 之类的绕过
  url = url.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (!url) return "";
  const m = url.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
  if (!m) return url; // 无协议：相对路径 / 锚点 / 站内地址，放行
  const scheme = m[1].toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel") return url;
  if (allowDataImage && /^data:image\/(png|jpe?g|gif|webp|avif|bmp)[;,]/i.test(url)) return url;
  return "";
}

// 与 app.js mdToHtml() 逐条对齐（含 h2/h3 的 sec-N 锚点编号方式）
export function renderMarkdown(md) {
  function inline(text) {
    return esc(text)
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => {
        const url = safeUrl(src, true);
        return url ? `<img src="${url}" alt="${alt}" loading="lazy" decoding="async">` : alt;
      })
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, href) => {
        const url = safeUrl(href, false);
        return url ? `<a href="${url}" target="_blank" rel="noopener nofollow">${label}</a>` : label;
      })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/^&gt; (.+)$/gm, "<blockquote><p>$1</p></blockquote>");
  }
  const lines = String(md == null ? "" : md).split("\n");
  let html = "", i = 0, hCount = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim().split(/\s+/)[0] || "";
      const code = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) { code.push(lines[i]); i++; }
      i++; html += `<pre><code class="language-${lang}">${esc(code.join("\n"))}</code></pre>`; continue;
    }
    if (/^> /.test(line)) {
      const q = []; while (i < lines.length && /^> /.test(lines[i])) { q.push(lines[i].slice(2)); i++; }
      html += `<blockquote>${q.map((ln) => `<p>${inline(ln)}</p>`).join("")}</blockquote>`; continue;
    }
    // 正文标题从 h2 起步：h1 归文章标题所有（一页只能有一个 h1），所以 "# " 与 "## " 都落 h2，"### " 落 h3。
    // 与 assets/app.js 的 mdToHtml() 必须逐条一致（verify-seo-render 会比对两边输出）。
    if (line.startsWith("### ")) { html += `<h3 id="sec-${++hCount}">${inline(line.slice(4))}</h3>`; i++; continue; }
    if (line.startsWith("## ")) { html += `<h2 id="sec-${++hCount}">${inline(line.slice(3))}</h2>`; i++; continue; }
    if (line.startsWith("# ")) { html += `<h2 id="sec-${++hCount}">${inline(line.slice(2))}</h2>`; i++; continue; }
    if (/^[-*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) { items.push(`<li>${inline(lines[i].slice(2))}</li>`); i++; }
      html += `<ul>${items.join("")}</ul>`; continue;
    }
    if (line.trim() === "") { i++; continue; }
    html += `<p>${inline(line)}</p>`; i++;
  }
  return html;
}

// 正文里内嵌的 base64 图片 → 独立静态文件。
// 原因：爬虫无法把 data: URI 当图片抓取（图片搜索收录不了），且 base64 会把响应体撑到几百 KB。
// 文件名用**内容哈希**：同一张图在多篇文章里只落一份；内容变则文件名变，可安全长缓存。
// 文件名保持纯 ASCII —— Cloudflare Pages 对含非 ASCII 的静态资源文件名不可靠
// （线上实测过「映射表登记了、文件却 404」），所以一律不把 slug/alt 写进文件名。
const BODY_IMG_RE = /!\[([^\]]*)\]\(\s*(data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+))\s*\)/g;

export function materializeBodyImages(body, { outDir, urlPrefix }) {
  const saved = [];
  const md = String(body == null ? "" : body);
  if (!md.includes("data:image")) return { markdown: md, saved };
  const out = md.replace(BODY_IMG_RE, (whole, alt, _uri, mime, b64) => {
    // ⚠️ 捕获到的 mime 已经是子类型（"jpeg" / "png"），不要再按 "/" 切一次 ——
    // 那样会切出 undefined 并静默落到 "png" 兜底，把 JPEG 存成 .png，
    // 而 Pages 按扩展名发 Content-Type，等于对外宣称了错误的类型。
    const ext = String(mime || "png").split("+")[0].replace(/^jpeg$/, "jpg").toLowerCase();
    // svg 是唯一「图片格式里能执行脚本」的：前端 safeUrl() 会拒收 data:image/svg+xml
    // 并把它降级成纯文本（alt）。这里若落盘成可访问文件，爬虫看到图、真人看到文字，
    // 两边就不一致了 —— 所以 svg 原样留给渲染器走同一条降级路径。
    if (ext === "svg" || ext === "svgz") return whole;
    let buf;
    try { buf = Buffer.from(b64.replace(/\s+/g, ""), "base64"); } catch (_) { return whole; }
    if (!buf.length) return whole;
    const hash8 = createHash("sha256").update(buf).digest("hex").slice(0, 8);
    const name = `${hash8}.${ext}`;
    try {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, name), buf);
      saved.push({ name, bytes: buf.length });
    } catch (_) {
      return whole; // 落盘失败就保留原样（渲染器仍会内联 base64，不影响正文文本收录）
    }
    return `![${alt}](${urlPrefix}/${name})`;
  });
  return { markdown: out, saved };
}

// 生成给爬虫读的文章主体 HTML。
// 结构与 app.js openPost() 渲染的结果保持一致（同 class、同层级、同图片属性），
// 只去掉纯交互元素（分享按钮、评论表单、目录）—— 爬虫拿它们没用，也无法交互。
export function buildArticleHtml({ title, tag, date, author, readingMinutes, words, views, coverUrl, bodyHtml }) {
  const metaBits = [
    tag ? `<span class="tag">${esc(tag)}</span>` : "",
    date ? `<span>${esc(date)}</span>` : "",
    author ? `<span class="author">✍ ${esc(author)}</span>` : "",
    readingMinutes ? `<span class="read-time">⏱ 约 ${esc(readingMinutes)} 分钟 · ${esc(words || 0)} 字${views ? ` · ${esc(views)} 阅读` : ""}</span>` : "",
  ].filter(Boolean).join("");
  const cover = coverUrl ? `<img class="post-cover" src="${esc(coverUrl)}" alt="${esc(title)}">` : "";
  return (
    `<div class="post-meta">${metaBits}</div>` +
    cover +
    // 文章标题是这一页唯一的 h1 —— 必须与 app.js openPost() 渲染出的层级完全一致，
    // 否则同一个 URL 对爬虫和真人是两套大纲（爬虫看到 h2、真人看到 h1），
    // 百度/Google 判定的页面主题会跟着变。verify-heading-outline 会两侧一起断言。
    `<h1>${esc(title)}</h1>` +
    `<div class="post-body">${bodyHtml}</div>`
  );
}

// 片段文件名：slug 的哈希，纯 ASCII 且长度固定。
// 不直接用 slug —— slug 含中文，而 Pages 对非 ASCII 文件名不可靠（见上）。
// 对应关系一律走 generated/post-html.json 映射表，任何一方都不从文件名反推 slug。
export function articleFileName(slug) {
  return createHash("sha256").update(String(slug || "post")).digest("hex").slice(0, 16) + ".html";
}
