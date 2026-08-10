// ===== 博客交互逻辑（直接读取 GitHub 仓库 Markdown，无需 index.json 维护）=====
(function () {
  const REPO = "night136/blog";
  const BRANCH = "main";
  const POSTS_API = `https://api.github.com/repos/${REPO}/contents/content/posts`;
  const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/content/posts`;

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
  const cardGrid = document.getElementById("cardGrid");
  const filterBar = document.getElementById("filterBar");
  const slidesEl = document.getElementById("slides");
  const slideDotsEl = document.getElementById("slideDots");
  const slidePrev = document.getElementById("slidePrev");
  const slideNext = document.getElementById("slideNext");
  const sliderEl = document.getElementById("slider");
  const backTop = document.getElementById("backTop");

  let posts = [];
  let postCache = {};
  let activeTag = "全部";
  let currentSlide = 0;
  let totalSlides = 0;
  let slideTimer = null;

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

  // 极简 Markdown -> HTML（含图片、链接、加粗、斜体、行内代码）
  function mdToHtml(md) {
    const esc = (s) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    function inlineHtml(text) {
      return esc(text)
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
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

  // 根据标题生成稳定渐变（无封面时占位）
  function gradFor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return `linear-gradient(135deg, hsl(${h},62%,58%), hsl(${(h + 45) % 360},62%,46%))`;
  }

  // 封面样式：有 cover 用图片，否则渐变
  function coverStyle(post) {
    if (post.cover) return `background-image:url('${post.cover}');`;
    return `background:${gradFor(post.title)};`;
  }

  // 阅读时长（分钟，按中文约 350 字/分钟）
  function readingTime(body) {
    const words = (body || "").replace(/\s/g, "").length;
    return Math.max(1, Math.round(words / 350));
  }

  // 从本地 index.json 读取文章 id 列表（Cloudflare 部署自带，无限流）；
  // 失败再回退到 GitHub API 列目录（匿名，可能限流）
  async function fetchPostIds() {
    try {
      const res = await fetch("content/posts/index.json");
      if (res.ok) {
        const data = await res.json();
        const ids = (data.posts || [])
          .map((p) => p.id || (p.file || "").replace(/\.md$/, ""))
          .filter(Boolean);
        if (ids.length) return ids;
      }
    } catch (e) {}
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
    } catch (e) {}
    return [];
  }

  async function fetchPostBody(id) {
    const res = await fetch(`${RAW_BASE}/${encodeURIComponent(id)}.md?t=${Date.now()}`);
    if (!res.ok) throw new Error("fetch failed");
    return await res.text();
  }

  // ===== 特色轮播 =====
  function renderSlider() {
    const top = posts.slice(0, Math.min(5, posts.length));
    if (!top.length) { if (sliderEl) sliderEl.style.display = "none"; return; }
    slidesEl.innerHTML = top
      .map(
        (p, i) => `
      <div class="slide ${i === 0 ? "active" : ""}" data-id="${p.id}" style="${coverStyle(p)}">
        <div class="slide-overlay">
          <span class="slide-tag">${p.tag}</span>
          <h3 class="slide-title">${p.title}</h3>
          <p class="slide-summary">${p.summary}</p>
          <button class="slide-read" data-id="${p.id}">阅读全文 →</button>
        </div>
      </div>`
      )
      .join("");
    slideDotsEl.innerHTML = top
      .map(
        (_, i) =>
          `<button class="dot ${i === 0 ? "active" : ""}" data-i="${i}" aria-label="第${i + 1}张"></button>`
      )
      .join("");
    slidesEl
      .querySelectorAll(".slide-read")
      .forEach((b) =>
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          openPost(b.dataset.id);
        })
      );
    slidesEl
      .querySelectorAll(".slide")
      .forEach((s) => s.addEventListener("click", () => openPost(s.dataset.id)));
    slideDotsEl
      .querySelectorAll(".dot")
      .forEach((d) => d.addEventListener("click", () => goSlide(+d.dataset.i)));
    currentSlide = 0;
    totalSlides = top.length;
    startAuto();
  }

  function goSlide(i) {
    if (!totalSlides) return;
    currentSlide = (i + totalSlides) % totalSlides;
    slidesEl
      .querySelectorAll(".slide")
      .forEach((s, idx) => s.classList.toggle("active", idx === currentSlide));
    slideDotsEl
      .querySelectorAll(".dot")
      .forEach((d, idx) => d.classList.toggle("active", idx === currentSlide));
  }

  function startAuto() {
    stopAuto();
    slideTimer = setInterval(() => goSlide(currentSlide + 1), 5000);
  }
  function stopAuto() {
    if (slideTimer) clearInterval(slideTimer);
    slideTimer = null;
  }

  // ===== 分类筛选 =====
  function renderFilters() {
    const tags = ["全部", ...Array.from(new Set(posts.map((p) => p.tag).filter(Boolean)))];
    filterBar.innerHTML = tags
      .map((t) => `<button class="chip ${t === activeTag ? "active" : ""}" data-tag="${t}">${t}</button>`)
      .join("");
    filterBar.querySelectorAll(".chip").forEach((c) =>
      c.addEventListener("click", () => {
        activeTag = c.dataset.tag;
        filterBar
          .querySelectorAll(".chip")
          .forEach((x) => x.classList.toggle("active", x === c));
        renderCards();
      })
    );
  }

  // ===== 卡片网格 =====
  function renderCards() {
    const list = activeTag === "全部" ? posts : posts.filter((p) => p.tag === activeTag);
    if (!list.length) {
      cardGrid.innerHTML = `<p style="color:var(--text-faint)">该分类下暂无文章。</p>`;
      return;
    }
    cardGrid.innerHTML = list
      .map(
        (p) => `
      <article class="card" data-id="${p.id}">
        <div class="card-cover" style="${coverStyle(p)}"></div>
        <div class="card-body">
          <div class="card-meta">
            <span class="tag">${p.tag}</span>
            <span>${formatDate(p.date)}</span>
            <span>✍ ${p.author}</span>
          </div>
          <h3>${p.title}</h3>
          <p>${p.summary}</p>
          <div class="card-foot"><span>约 ${readingTime(p.body)} 分钟</span><span class="card-go">阅读 →</span></div>
        </div>
      </article>`
      )
      .join("");
    cardGrid
      .querySelectorAll(".card")
      .forEach((el) => el.addEventListener("click", () => openPost(el.dataset.id)));
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
    archiveList
      .querySelectorAll(".archive-item")
      .forEach((el) => el.addEventListener("click", () => openPost(el.dataset.id)));
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
    navLinks.forEach((l) => l.classList.toggle("active", l.dataset.view === name));
  }

  function skeletonHTML() {
    return Array.from({ length: 4 })
      .map(
        () => `
      <div class="sk-card">
        <div class="sk-cover skeleton"></div>
        <div class="sk-line skeleton"></div>
        <div class="sk-line short skeleton"></div>
      </div>`
      )
      .join("");
  }

  async function loadPosts() {
    cardGrid.innerHTML = skeletonHTML();
    const ids = await fetchPostIds();
    if (!ids.length) {
      cardGrid.innerHTML = `<p style="color:var(--text-faint)">暂时没有文章。在 Decap CMS（/admin/）发布后会自动出现在这里。</p>`;
      if (sliderEl) sliderEl.style.display = "none";
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
            cover: meta.cover || "",
            body,
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
      cardGrid.innerHTML = `<p style="color:var(--text-faint)">文章加载失败，请稍后重试。</p>`;
      return;
    }
    renderSlider();
    renderFilters();
    renderCards();
    renderArchive();
  }

  // ===== 农历 + 时辰显示 =====
  const DI_ZHI = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
  const SHICHEN_RANGE = [
    "23:00–01:00", "01:00–03:00", "03:00–05:00", "05:00–07:00",
    "07:00–09:00", "09:00–11:00", "11:00–13:00", "13:00–15:00",
    "15:00–17:00", "17:00–19:00", "19:00–21:00", "21:00–23:00",
  ];

  function updateLunar() {
    const el = document.getElementById("lunarClock");
    if (!el) return;
    if (typeof Lunar === "undefined") {
      el.textContent = "农历组件加载中…";
      return;
    }
    const now = new Date();
    const lunar = Lunar.fromDate(now);
    const ganZhi = lunar.getYearInGanZhi();
    const shengXiao = lunar.getYearShengXiao();
    const month = lunar.getMonthInChinese();
    const day = lunar.getDayInChinese();
    const idx = Math.floor(((now.getHours() + 1) % 24) / 2);
    const shichen = DI_ZHI[idx];

    const pad = (n) => String(n).padStart(2, "0");
    const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    el.innerHTML =
      `🗓 ${ganZhi}年（${shengXiao}）${month}月${day} · ` +
      `<strong>${shichen}时</strong> ` +
      `<span class="lunar-time">${hm}</span>`;
    el.title = `农历时辰：${shichen}时（${SHICHEN_RANGE[idx]}）`;
  }

  // ===== 交互绑定 =====
  window.addEventListener("scroll", () => {
    if (backTop) backTop.classList.toggle("show", window.scrollY > 400);
  });
  if (backTop)
    backTop.addEventListener("click", () =>
      window.scrollTo({ top: 0, behavior: "smooth" })
    );

  if (sliderEl) {
    sliderEl.addEventListener("mouseenter", stopAuto);
    sliderEl.addEventListener("mouseleave", startAuto);
  }
  if (slidePrev) slidePrev.addEventListener("click", () => goSlide(currentSlide - 1));
  if (slideNext) slideNext.addEventListener("click", () => goSlide(currentSlide + 1));

  navLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      showView(link.dataset.view);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
  backBtn.addEventListener("click", () => showView("home"));

  updateLunar();
  setInterval(updateLunar, 1000);

  loadPosts();
})();
