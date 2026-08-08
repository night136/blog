// ===== 博客交互逻辑（直接读取 GitHub 仓库 Markdown，无需 index.json 维护）=====
(function () {
  const BASE = "content/posts/";

  // 仓库信息：通过 GitHub 公开 API 列出文章，再读取原始 Markdown
  const REPO = "night136/blog";
  const BRANCH = "main";
  const POSTS_API = `https://api.github.com/repos/${REPO}/contents/content/posts`;
  const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/content/posts`;

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
  let postCache = {}; // 缓存已加载的文章正文 HTML

  // 解析 frontmatter，返回 { meta, body }
  function parseFrontmatter(raw) {
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!m) return { meta: {}, body: raw };
    const meta = {};
    m[1].split("\n").forEach((line) => {
      const i = line.indexOf(":");
      if (i > -1) {
        const k = line.slice(0, i).trim();
        const v = line
          .slice(i + 1)
          .trim()
          .replace(/^["']|["']$/g, "");
        meta[k] = v;
      }
    });
    return { meta, body: m[2] || "" };
  }

  // 极简 Markdown -> HTML
  function mdToHtml(md) {
    const esc = (s) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // 解析行内 Markdown：链接、图片、加粗、斜体、行内代码
    function inlineHtml(text) {
      return esc(text)
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    }

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
      if (line.startsWith("### ")) { html += `<h3>${inlineHtml(line.slice(4))}</h3>`; i++; continue; }
      if (line.startsWith("## ")) { html += `<h3>${inlineHtml(line.slice(3))}</h3>`; i++; continue; }
      if (line.startsWith("# ")) { html += `<h2>${inlineHtml(line.slice(2))}</h2>`; i++; continue; }
      if (/^[-*] /.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*] /.test(lines[i])) { items.push(`<li>${inlineHtml(lines[i].slice(2))}</li>`); i++; }
        html += `<ul>${items.join("")}</ul>`;
        continue;
      }
      if (line.trim() === "") { i++; continue; }
      html += `<p>${inlineHtml(line)}</p>`;
      i++;
    }
    return html;
  }

  function formatDate(d) {
    const [y, m, day] = d.split("-");
    return `${y}年${Number(m)}月${Number(day)}日`;
  }

  // 从 GitHub API 列出 content/posts 下的 .md 文件名；失败则回退 index.json
  async function fetchPostIds() {
    try {
      const res = await fetch(POSTS_API, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (res.ok) {
        const items = await res.json();
        const ids = items
          .filter(
            (it) =>
              it.type === "file" &&
              it.name.endsWith(".md") &&
              it.name !== "index.json"
          )
          .map((it) => it.name.replace(/\.md$/, ""));
        if (ids.length) return ids;
      }
    } catch (e) {
      /* 走到兜底 */
    }
    // 兜底：读取已有的 index.json
    try {
      const res = await fetch(BASE + "index.json");
      if (res.ok) {
        const data = await res.json();
        return (data.posts || [])
          .map((p) => p.id || (p.file || "").replace(/\.md$/, ""))
          .filter(Boolean);
      }
    } catch (e) {}
    return [];
  }

  // 读取单篇文章原始 Markdown（带缓存破坏参数，确保发新文章后能立即看到）
  async function fetchPostBody(id) {
    const res = await fetch(`${RAW_BASE}/${id}.md?t=${Date.now()}`);
    if (!res.ok) throw new Error("fetch failed");
    return await res.text();
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
        const raw = await fetchPostBody(id);
        html = mdToHtml(parseFrontmatter(raw).body);
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

  // 加载全部文章：列出 -> 逐篇读取 frontmatter -> 渲染
  async function loadPosts() {
    postList.innerHTML = `<p style="color:#9a9ab0">正在加载文章…</p>`;
    const ids = await fetchPostIds();
    if (!ids.length) {
      postList.innerHTML = `<p style="color:#9a9ab0">暂时没有文章。在 Decap CMS（/admin/）发布后会自动出现在这里。</p>`;
      return;
    }
    const loaded = await Promise.all(
      ids.map(async (id) => {
        try {
          const raw = await fetchPostBody(id);
          const { meta, body } = parseFrontmatter(raw);
          postCache[id] = mdToHtml(body);
          return {
            id,
            file: id + ".md",
            title: meta.title || id,
            date: meta.date || "1970-01-01",
            tag: meta.tag || "未分类",
            author: meta.author || "昉昕",
            summary:
              meta.summary ||
              body.replace(/[#>*`\-\s]/g, " ").slice(0, 80).trim(),
          };
        } catch (e) {
          return null;
        }
      })
    );
    posts = loaded
      .filter(Boolean)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    if (!posts.length) {
      postList.innerHTML = `<p style="color:#9a9ab0">文章加载失败，请稍后重试。</p>`;
      return;
    }
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
