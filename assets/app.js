// ===== 博客交互逻辑（index.json + Markdown 驱动）=====
(function () {
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
  let postCache = {}; // 缓存已加载的文章正文

  // 解析 frontmatter（仅用于从全文 md 提取正文）
  function splitFrontmatter(raw) {
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!m) return { body: raw };
    return { body: m[2] };
  }

  // 极简 Markdown -> HTML
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
            <span class="author">✍ ${p.author}</span>
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

  async function openPost(id) {
    const p = posts.find((x) => x.id === id);
    if (!p) return;
    let html = postCache[id];
    if (!html) {
      try {
        const res = await fetch(BASE + p.file);
        const raw = res.ok ? await res.text() : "";
        html = mdToHtml(splitFrontmatter(raw).body);
        postCache[id] = html;
      } catch (e) {
        html = "<p>文章加载失败，请稍后重试。</p>";
      }
    }
    postDetail.innerHTML = `
      <div class="post-meta">
        <span class="tag">${p.tag}</span>
        <span>${formatDate(p.date)}</span>
        <span class="author">✍ ${p.author}</span>
      </div>
      <h2>${p.title}</h2>
      ${html}
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

  async function loadIndex() {
    try {
      const res = await fetch(BASE + "index.json");
      if (!res.ok) throw new Error("index.json not found");
      const data = await res.json();
      posts = (data.posts || []).sort((a, b) => (a.date < b.date ? 1 : -1));
      renderHome();
      renderArchive();
    } catch (e) {
      console.error("加载文章索引失败:", e);
      postList.innerHTML = `<p style="color:#9a9ab0">暂时无法加载文章列表，请检查 content/posts/index.json 是否存在。</p>`;
    }
  }

  navLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      showView(link.dataset.view);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
  backBtn.addEventListener("click", () => showView("home"));

  loadIndex();
})();
