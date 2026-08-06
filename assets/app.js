// ===== 博客交互逻辑（Markdown 驱动）=====
(function () {
  // 文章清单：部署前由构建脚本或手动维护（列出 content/posts 下的 md 文件）
  const POST_FILES = [
    "daily-bot-nodejs.md",
    "cloudflare-pages-static.md",
    "reading-notes-deep-work.md",
    "js-closure-again.md",
  ];

  const BASE = "content/posts/";
  const postList = document.getElementById("postList");
  const archiveList = document.getElementById("archiveList");
  const postDetail = document.getElementById("postDetail");
  const backBtn = document.getElementById("backBtn");
  const navLinks = document.querySelectorAll(".nav-link");
  const views = {
    home: document.querySelector(".view-home"),
    archive: document.querySelector(".view-archive"),
    about: document.querySelector(".view-about"),
    post: document.querySelector(".view-post"),
  };

  let posts = [];

  // 极简 frontmatter 解析
  function parseFrontmatter(raw) {
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!m) return { meta: {}, body: raw };
    const meta = {};
    m[1].split("\n").forEach((line) => {
      const i = line.indexOf(":");
      if (i > -1) {
        const k = line.slice(0, i).trim();
        let v = line.slice(i + 1).trim();
        v = v.replace(/^["']|["']$/g, "");
        meta[k] = v;
      }
    });
    return { meta, body: m[2] };
  }

  // 轻量 Markdown -> HTML（标题/段落/列表/代码块/行内 code）
  function mdToHtml(md) {
    const esc = (s) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const lines = md.split("\n");
    let html = "", i = 0;
    while (i < lines.length) {
      let line = lines[i];
      if (line.startsWith("```")) {
        const code = [];
        i++;
        while (i < lines.length && !lines[i].startsWith("```")) { code.push(lines[i]); i++; }
        i++;
        html += `<pre><code>${esc(code.join("\n"))}</code></pre>`;
        continue;
      }
      if (line.startsWith("### ")) { html += `<h3>${esc(line.slice(4))}</h3>`; i++; continue; }
      if (line.startsWith("## ")) { html += `<h3>${esc(line.slice(3))}</h3>`; i++; continue; }
      if (line.startsWith("# ")) { html += `<h2>${esc(line.slice(2))}</h2>`; i++; continue; }
      if (/^[-*] /.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*] /.test(lines[i])) { items.push(`<li>${esc(lines[i].slice(2))}</li>`); i++; }
        html += `<ul>${items.join("")}</ul>`;
        continue;
      }
      if (line.trim() === "") { i++; continue; }
      const txt = esc(line).replace(/`([^`]+)`/g, "<code>$1</code>");
      html += `<p>${txt}</p>`;
      i++;
    }
    return html;
  }

  function formatDate(d) {
    const [y, m, day] = d.split("-");
    return `${y}年${Number(m)}月${Number(day)}日`;
  }

  function renderHome() {
    postList.innerHTML = posts
      .map(
        (p) => `
        <article class="post-card" data-id="${p.id}">
          <div class="post-meta">
            <span class="tag">${p.tag}</span>
            <span>${formatDate(p.date)}</span>
          </div>
          <h3>${p.title}</h3>
          <p>${p.summary}</p>
        </article>`
      )
      .join("");
    postList.querySelectorAll(".post-card").forEach((el) => {
      el.addEventListener("click", () => openPost(el.dataset.id));
    });
  }

  function renderArchive() {
    archiveList.innerHTML = posts
      .map(
        (p) => `
        <div class="archive-item" data-id="${p.id}">
          <span class="archive-date">${p.date}</span>
          <span class="archive-title">${p.title}</span>
        </div>`
      )
      .join("");
    archiveList.querySelectorAll(".archive-item").forEach((el) => {
      el.addEventListener("click", () => openPost(el.dataset.id));
    });
  }

  function openPost(id) {
    const p = posts.find((x) => x.id === id);
    if (!p) return;
    postDetail.innerHTML = `
      <div class="post-meta">
        <span class="tag">${p.tag}</span>
        <span>${formatDate(p.date)}</span>
      </div>
      <h2>${p.title}</h2>
      ${p.html}
    `;
    showView("post");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showView(name) {
    Object.values(views).forEach((v) => v.classList.remove("active"));
    views[name].classList.add("active");
    navLinks.forEach((l) =>
      l.classList.toggle("active", l.dataset.view === name)
    );
  }

  async function loadPosts() {
    const loaded = await Promise.all(
      POST_FILES.map(async (f) => {
        const res = await fetch(BASE + f);
        if (!res.ok) return null;
        const raw = await res.text();
        const { meta, body } = parseFrontmatter(raw);
        return {
          id: f.replace(/\.md$/, ""),
          title: meta.title || f,
          date: meta.date || "1970-01-01",
          tag: meta.tag || "未分类",
          summary: meta.summary || "",
          html: mdToHtml(body),
        };
      })
    );
    posts = loaded
      .filter(Boolean)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    renderHome();
    renderArchive();
  }

  navLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      showView(link.dataset.view);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
  backBtn.addEventListener("click", () => showView("home"));

  loadPosts();
})();
