// ===== 昉昕的博客 — 前端交互 =====
(function () {
  // ── DOM 缓存 ──
  const $ = (id) => document.getElementById(id);
  const archiveList = $("archiveList");
  const postDetail = $("postDetail");
  const backBtn = $("backBtn");
  const navLinks = document.querySelectorAll(".nav-link");
  const views = {
    home: document.querySelector(".view-home"),
    archive: document.querySelector(".view-archive"),
    about: document.querySelector(".view-about"),
    member: document.querySelector(".view-member"),
    post: document.querySelector(".view-post"),
    compose: document.querySelector(".view-compose"),
  };
  const cardGrid = $("cardGrid");
  const filterBar = $("filterBar");
  const slidesEl = $("slides");
  const slideDotsEl = $("slideDots");
  const slidePrev = $("slidePrev");
  const slideNext = $("slideNext");
  const sliderEl = $("slider");
  const backTop = $("backTop");

  // ── 认证相关 DOM ──
  const authBtn = $("authBtn");
  const userChip = $("userChip");
  const userName = $("userName");
  const userAvatar = $("userAvatar");
  const logoutBtn = $("logoutBtn");
  const publishBtnChip = $("publishBtnChip");
  const authModal = $("authModal");
  const authClose = $("authClose");
  const loginForm = $("loginForm");
  const registerForm = $("registerForm");
  const loginMsg = $("loginMsg");
  const registerMsg = $("registerMsg");
  const memberArea = $("memberArea");

  // ── 全屏写作 DOM ──
  const composeBack = $("composeBack");
  const composeTitle = $("composeTitle");
  const composeTag = $("composeTag");
  const composeSummary = $("composeSummary");
  const composeCover = $("composeCover");
  const composeBody = $("composeBody");
  const composePreview = $("composePreview");
  const composeSubmit = $("composeSubmit");
  const composeMsg = $("composeMsg");

  // ── 搜索 ──
  const searchInput = $("searchInput");

  // ── 深色模式 ──
  const themeToggle = $("themeToggle");

  // ── 移动端 ──
  const hamburger = $("hamburger");
  const sidebar = $("sidebar");
  const sidebarOverlay = $("sidebarOverlay");
  const mainNav = $("mainNav");

  // ── 状态 ──
  let posts = [];
  let activeTag = "全部";
  let currentSlide = 0, totalSlides = 0, slideTimer = null;
  let searchQuery = "";

  // ===== Markdown → HTML =====
  function mdToHtml(md) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    function inline(text) {
      return esc(text)
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/^&gt; (.+)$/gm, "<blockquote><p>$1</p></blockquote>");
    }
    const lines = md.split("\n");
    let html = "", i = 0, hCount = 0;
    while (i < lines.length) {
      let line = lines[i];
      if (line.startsWith("```")) {
        const code = []; i++;
        while (i < lines.length && !lines[i].startsWith("```")) { code.push(lines[i]); i++; }
        i++; html += `<pre><code>${esc(code.join("\n"))}</code></pre>`; continue;
      }
      if (/^> /.test(line)) {
        const q = []; while (i < lines.length && /^> /.test(lines[i])) { q.push(lines[i].slice(2)); i++; }
        html += `<blockquote>${q.map((ln) => `<p>${inline(ln)}</p>`).join("")}</blockquote>`; continue;
      }
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

  function formatDate(d) { const [y, m, day] = d.split("-"); return `${y}年${Number(m)}月${Number(day)}日`; }
  function gradFor(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360; return `linear-gradient(135deg, hsl(${h},62%,58%), hsl(${(h + 45) % 360},62%,46%))`; }
  function coverStyle(p) { return p.cover ? `background-image:url('${p.cover}');` : `background:${gradFor(p.title)};`; }
  function readingTime(body) { return Math.max(1, Math.round((body || "").replace(/\s/g, "").length / 350)); }

  // ===== 数据 =====
  async function fetchAllPosts() {
    const res = await fetch("/api/posts", { credentials: "same-origin" });
    if (!res.ok) throw new Error("list " + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error("bad list");
    return data.posts || [];
  }

  // ===== 轮播 =====
  function renderSlider() {
    const top = posts.slice(0, Math.min(5, posts.length));
    if (!top.length) { if (sliderEl) sliderEl.style.display = "none"; return; }
    if (sliderEl) sliderEl.style.display = "block";
    slidesEl.innerHTML = top.map((p, i) => `
      <div class="slide ${i === 0 ? "active" : ""}" data-slug="${p.slug}" style="${coverStyle(p)}">
        <div class="slide-overlay"><span class="slide-tag">${p.tag}</span><h3 class="slide-title">${p.title}</h3><p class="slide-summary">${p.summary || ""}</p><button class="slide-read" data-slug="${p.slug}">阅读全文 →</button></div>
      </div>`).join("");
    slideDotsEl.innerHTML = top.map((_, i) => `<button class="dot ${i === 0 ? "active" : ""}" data-i="${i}"></button>`).join("");
    slidesEl.querySelectorAll(".slide-read").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); openPost(b.dataset.slug); }));
    slidesEl.querySelectorAll(".slide").forEach((s) => s.addEventListener("click", () => openPost(s.dataset.slug)));
    slideDotsEl.querySelectorAll(".dot").forEach((d) => d.addEventListener("click", () => goSlide(+d.dataset.i)));
    currentSlide = 0; totalSlides = top.length; startAuto();
  }
  function goSlide(i) { if (!totalSlides) return; currentSlide = (i + totalSlides) % totalSlides; slidesEl.querySelectorAll(".slide").forEach((s, ix) => s.classList.toggle("active", ix === currentSlide)); slideDotsEl.querySelectorAll(".dot").forEach((d, ix) => d.classList.toggle("active", ix === currentSlide)); }
  function startAuto() { stopAuto(); slideTimer = setInterval(() => goSlide(currentSlide + 1), 5000); }
  function stopAuto() { if (slideTimer) clearInterval(slideTimer); slideTimer = null; }

  // ===== 筛选+搜索 =====
  function getFiltered() {
    let list = activeTag === "全部" ? posts : posts.filter((p) => p.tag === activeTag);
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((p) => (p.title + " " + (p.summary || "")).toLowerCase().includes(q));
    }
    return list;
  }

  function renderFilters() {
    const tags = ["全部", ...Array.from(new Set(posts.map((p) => p.tag).filter(Boolean)))];
    filterBar.innerHTML = tags.map((t) => `<button class="chip ${t === activeTag ? "active" : ""}" data-tag="${t}">${t}</button>`).join("");
    filterBar.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { activeTag = c.dataset.tag; filterBar.querySelectorAll(".chip").forEach((x) => x.classList.toggle("active", x === c)); renderCards(); }));
  }

  function renderCards() {
    const list = getFiltered();
    if (!list.length) { cardGrid.innerHTML = `<p style="color:var(--text-faint);grid-column:1/-1;">${searchQuery ? "没有匹配「" + searchQuery + "」的文章。" : "该分类下暂无文章。"}</p>`; return; }
    cardGrid.innerHTML = list.map((p, i) => `
      <article class="card ${i === 0 ? "feature" : i === 1 ? "wide" : ""}" data-slug="${p.slug}">
        <div class="card-cover" style="${coverStyle(p)}"></div>
        <div class="card-body">
          <div class="card-meta"><span class="tag">${p.tag}</span><span>${formatDate(p.date)}</span><span>✍ ${p.author}</span></div>
          <h3>${p.title}</h3><p>${p.summary || ""}</p>
          <div class="card-foot"><span>约 ${readingTime(p.summary || p.title)} 分钟</span><span class="card-go">阅读 →</span></div>
        </div></article>`).join("");
    cardGrid.querySelectorAll(".card").forEach((el) => el.addEventListener("click", () => openPost(el.dataset.slug)));
  }

  function renderArchive() {
    archiveList.innerHTML = posts.map((p) => `<div class="archive-item" data-slug="${p.slug}"><span class="archive-date">${p.date}</span><span class="archive-title">${p.title}</span></div>`).join("");
    archiveList.querySelectorAll(".archive-item").forEach((el) => el.addEventListener("click", () => openPost(el.dataset.slug)));
  }

  // 侧边栏小部件：最近文章 + 标签云
  function renderWidgets() {
    const recent = $("recentList");
    if (recent) {
      recent.innerHTML = posts.slice(0, 5).map((p) => `<li><a href="#" data-slug="${escapeHtml(p.slug)}">${escapeHtml(p.title)}</a><span class="w-date">${p.date}</span></li>`).join("");
      recent.querySelectorAll("a").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); openPost(a.dataset.slug); }));
    }
    const cloud = $("tagCloud");
    if (cloud) {
      const tags = Array.from(new Set(posts.map((p) => p.tag).filter(Boolean)));
      cloud.innerHTML = (tags.length ? tags : ["未分类"]).map((t) => `<button class="w-tag" type="button" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join("");
      cloud.querySelectorAll(".w-tag").forEach((b) => b.addEventListener("click", () => { activeTag = b.dataset.tag; renderFilters(); renderCards(); showView("home"); }));
    }
  }

  // 从正文解析目录（与 mdToHtml 标题 id 规则一致：## / ###）
  function buildToc(md) {
    const lines = (md || "").split("\n");
    const toc = []; let hN = 0, inCode = false;
    for (const line of lines) {
      if (line.startsWith("```")) { inCode = !inCode; continue; }
      if (inCode) continue;
      const m = line.match(/^(#{1,3})\s+(.+)$/);
      if (!m) continue;
      hN++;
      if (m[1].length === 1) continue; // # 不列入目录
      toc.push({ level: m[1].length, text: m[2].replace(/[*`_]/g, "").trim(), id: "sec-" + hN });
    }
    return toc;
  }

  async function openPost(slug) {
    // 列表不含 body（避免 base64 图片拖慢首页），详情按需拉取单篇
    const p = posts.find((x) => x.slug === slug);
    if (p) postDetail.innerHTML = `<div class="post-meta"><span class="tag">${p.tag}</span><span>${formatDate(p.date)}</span><span class="author">✍ ${p.author}</span></div><h2>${p.title}</h2><p style="color:var(--text-faint)">加载中…</p>`;
    showView("post"); window.scrollTo({ top: 0, behavior: "smooth" });
    try {
      // slug 放 body，避免部分国产浏览器（小米等）fetch 对中文 slug 的 % 编码损坏
      const res = await fetch("/api/posts/detail", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) });
      const data = await res.json();
      if (!res.ok || !data.ok || !data.post) { postDetail.innerHTML = `<p style="color:var(--text-faint)">文章加载失败：${(data && data.error) || res.status}</p>`; return; }
      const post = data.post;
      currentUser = await checkSession();
      currentSlug = slug;
      currentPostAuthor = post.author;
      const hero = post.cover ? `<img class="post-cover" src="${post.cover}" alt="">` : "";
      const toc = buildToc(post.body || "");
      const tocHtml = toc.length ? `<nav class="toc"><div class="toc-title">📑 目录</div><ul class="toc-list">${toc.map((t) => `<li class="toc-l${t.level}"><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`).join("")}</ul></nav>` : "";
      postDetail.innerHTML = `<div class="post-meta"><span class="tag">${post.tag}</span><span>${formatDate(post.date)}</span><span class="author">✍ ${post.author}</span></div>${hero}<h2>${post.title}</h2>${tocHtml}<div class="post-body">${mdToHtml(post.body || "")}</div><section class="comments" id="comments"><div class="comments-head"><h3 class="comments-title">💬 评论</h3><div class="comment-sort"><button class="sort-btn active" data-sort="new" type="button">最新</button><button class="sort-btn" data-sort="hot" type="button">最热</button></div></div><div class="comment-list" id="commentList"><p class="comments-loading">加载评论中…</p></div><div class="reply-hint" id="replyHint" hidden>回复 <b id="replyName"></b><button type="button" id="replyCancel" class="reply-cancel" title="取消回复">✕</button></div><form class="comment-form" id="commentForm"><input class="comment-name" id="commentName" type="text" placeholder="昵称（可不填）" maxlength="40"><textarea class="comment-input" id="commentInput" placeholder="说点什么…" maxlength="2000"></textarea><div class="comment-actions"><span class="comment-msg" id="commentMsg"></span><button class="btn-submit" type="submit">发表评论</button></div></form></section>`;
      bindCommentForm(slug);
      prefillCommentName();
      loadComments(slug);
    } catch (_) { postDetail.innerHTML = `<p style="color:var(--text-faint)">文章加载失败，请重试</p>`; }
  }

  // ===== 评论 =====
  function escapeHtml(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  // 单条评论的 HTML（顶层与回复复用）
  function renderCommentItem(c, isOwner) {
    const liked = localStorage.getItem("liked:" + c.id) ? " liked" : "";
    const del = isOwner ? `<button class="comment-del" data-del="${c.id}" title="删除评论">删除</button>` : "";
    const replyBtn = `<button class="comment-reply" data-reply="${c.id}" data-name="${escapeHtml(c.name)}" type="button">回复</button>`;
    return `<div class="comment-item" data-id="${c.id}"><div class="comment-head"><span class="comment-author">${escapeHtml(c.name)}</span><span class="comment-time">${escapeHtml(c.created_at)}</span></div><p class="comment-text">${escapeHtml(c.content)}</p><div class="comment-foot"><button class="comment-like${liked}" data-like="${c.id}">👍 <span class="like-count">${c.likes || 0}</span></button>${replyBtn}${del}</div></div>`;
  }

  async function loadComments(slug) {
    const list = $("commentList"); if (!list) return;
    try {
      const res = await fetch("/api/posts/comments", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "list", slug }) });
      const data = await res.json();
      if (!res.ok || !data.ok) { list.innerHTML = `<p style="color:var(--text-faint)">评论加载失败：${(data && data.error) || res.status}</p>`; return; }
      const cs = data.comments || [];
      if (!cs.length) { list.innerHTML = `<p class="comments-empty">还没有评论，来抢沙发～</p>`; return; }
      const isOwner = !!(currentUser && currentUser.username && currentPostAuthor === currentUser.username);
      // 分组：顶层评论 parent_id 为空，回复挂到对应父评论
      const tops = cs.filter((c) => !c.parent_id).map((c) => ({ ...c, replies: [] }));
      const topMap = new Map(); tops.forEach((t) => topMap.set(t.id, t));
      cs.filter((c) => c.parent_id).forEach((c) => {
        const p = topMap.get(c.parent_id);
        if (p) p.replies.push(c);
        else tops.push({ ...c, replies: [] }); // 孤儿回复兜底（父被删但本应级联删）
      });
      // 排序：最新=created_at 倒序；最热=likes 倒序（并列按时间正序）
      const cmpTop = commentSort === "hot"
        ? (a, b) => ((b.likes || 0) - (a.likes || 0)) || (a.created_at < b.created_at ? -1 : 1)
        : (a, b) => (a.created_at > b.created_at ? -1 : 1);
      tops.sort(cmpTop);
      tops.forEach((t) => t.replies.sort((a, b) => (a.created_at > b.created_at ? 1 : -1))); // 回复恒按时间正序
      list.innerHTML = tops.map((t) => {
        const repliesHtml = t.replies.length
          ? `<div class="comment-replies">${t.replies.map((r) => renderCommentItem(r, isOwner)).join("")}</div>`
          : "";
        return renderCommentItem(t, isOwner) + repliesHtml;
      }).join("");
    } catch (_) { list.innerHTML = `<p style="color:var(--text-faint)">评论加载失败</p>`; }
  }

  function bindCommentForm(slug) {
    const form = $("commentForm"); if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = ($("commentName")?.value || "").trim();
      const content = ($("commentInput")?.value || "").trim();
      const msg = $("commentMsg");
      if (!content) { if (msg) { msg.textContent = "评论内容不能为空"; msg.className = "comment-msg err"; } return; }
      if (msg) { msg.textContent = "发表中…"; msg.className = "comment-msg"; }
      const btn = form.querySelector("button"); if (btn) btn.disabled = true;
      try {
        const res = await fetch("/api/posts/comments", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", slug, name, content, parent_id: replyTo }) });
        const data = await res.json();
        if (!res.ok || !data.ok) { if (msg) { msg.textContent = (data && data.error) || "发表失败"; msg.className = "comment-msg err"; } return; }
        if (msg) { msg.textContent = "✅ 已发表"; msg.className = "comment-msg ok"; }
        const input = $("commentInput"); if (input) input.value = "";
        resetReply(); // 退出回复模式（隐藏提示条）
        loadComments(slug);
      } catch (_) { if (msg) { msg.textContent = "网络错误"; msg.className = "comment-msg err"; } }
      finally { if (btn) btn.disabled = false; }
    });
  }

  // 评论区全局点击委托（列表容器会被重建，绑 document 更稳定）
  document.addEventListener("click", async (e) => {
    const tocLink = e.target.closest(".toc a");
    if (tocLink) { e.preventDefault(); const id = tocLink.getAttribute("href").slice(1); const t = document.getElementById(id); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    const likeBtn = e.target.closest(".comment-like");
    if (likeBtn) { e.preventDefault(); await handleLike(likeBtn); return; }
    const delBtn = e.target.closest(".comment-del");
    if (delBtn) { e.preventDefault(); await handleDelete(delBtn); return; }
    const replyBtn = e.target.closest(".comment-reply");
    if (replyBtn) { e.preventDefault(); handleReply(replyBtn); return; }
    const sortBtn = e.target.closest(".sort-btn");
    if (sortBtn) {
      e.preventDefault();
      if (commentSort === (sortBtn.dataset.sort || "new")) return;
      commentSort = sortBtn.dataset.sort || "new";
      document.querySelectorAll(".sort-btn").forEach((b) => b.classList.toggle("active", b === sortBtn));
      loadComments(currentSlug);
      return;
    }
    const replyCancel = e.target.closest("#replyCancel");
    if (replyCancel) { e.preventDefault(); resetReply(); return; }
  });
  async function handleLike(btn) {
    const id = btn.dataset.like;
    if (!id || localStorage.getItem("liked:" + id)) { btn.classList.add("liked"); return; }
    try {
      const res = await fetch("/api/posts/comments", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "like", slug: currentSlug, id: Number(id) }) });
      const data = await res.json();
      if (data.ok) { localStorage.setItem("liked:" + id, "1"); btn.classList.add("liked"); const span = btn.querySelector(".like-count"); if (span) span.textContent = data.likes; }
    } catch (_) {}
  }
  async function handleDelete(btn) {
    const id = btn.dataset.del;
    if (!id) return;
    if (!confirm("确定删除这条评论吗？")) return;
    try {
      const res = await fetch("/api/posts/comments", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", slug: currentSlug, id: Number(id) }) });
      const data = await res.json();
      if (data.ok) loadComments(currentSlug);
      else alert((data && data.error) || "删除失败");
    } catch (_) { alert("网络错误"); }
  }

  // 登录用户发评自动带入昵称（仅 prefill，可改）
  function prefillCommentName() {
    const input = $("commentName");
    if (!input) return;
    if (currentUser && currentUser.username) input.value = currentUser.username;
  }

  // 进入回复模式：记录父评论 id，显示提示条并聚焦输入框
  function handleReply(btn) {
    const id = Number(btn.dataset.reply);
    if (!id) return;
    replyTo = id;
    const hint = $("replyHint");
    const rn = $("replyName");
    if (hint) hint.hidden = false;
    if (rn) rn.textContent = "@" + (btn.dataset.name || "该用户");
    const input = $("commentInput");
    if (input) input.focus();
  }

  // 退出回复模式
  function resetReply() {
    replyTo = 0;
    const hint = $("replyHint");
    if (hint) hint.hidden = true;
  }

  function showView(name) {
    Object.values(views).forEach((v) => v.classList.remove("active"));
    if (views[name]) views[name].classList.add("active");
    navLinks.forEach((l) => l.classList.toggle("active", l.dataset.view === name));
    // close mobile sidebar on nav
    if (sidebar) sidebar.classList.remove("open");
    if (sidebarOverlay) sidebarOverlay.hidden = true;
    document.body.style.overflow = "";
  }

  async function loadPosts() {
    cardGrid.innerHTML = Array.from({ length: 4 }).map(() => '<div class="sk-card"><div class="sk-cover skeleton"></div><div class="sk-line skeleton"></div><div class="sk-line short skeleton"></div></div>').join("");
    if (sliderEl) sliderEl.style.display = "block";
    try {
      posts = (await fetchAllPosts()).map((p) => ({ ...p, summary: p.summary || (p.title || "").replace(/[#>*`\-\s]/g, " ").slice(0, 80).trim() }));
    } catch (e) { cardGrid.innerHTML = `<p style="color:var(--text-faint)">文章加载失败：${e.message}</p>`; if (sliderEl) sliderEl.style.display = "none"; return; }
    if (!posts.length) { cardGrid.innerHTML = `<p style="color:var(--text-faint)">暂无文章。</p>`; return; }
    renderSlider(); renderFilters(); renderCards(); renderArchive(); renderWidgets();
  }

  // ===== 深色模式 =====
  function applyTheme(mode) {
    document.documentElement.setAttribute("data-theme", mode);
    try { localStorage.setItem("blog-theme", mode); } catch (_) {}
    document.querySelectorAll(".theme-toggle").forEach((b) => { b.textContent = mode === "dark" ? "☀️" : "🌙"; });
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme") || "light";
    applyTheme(cur === "dark" ? "light" : "dark");
  }
  { const saved = (() => { try { return localStorage.getItem("blog-theme"); } catch (_) { return null; } })();
    if (saved === "dark" || saved === "light") applyTheme(saved);
    else {
      const prefers = window.matchMedia("(prefers-color-scheme: dark)");
      applyTheme(prefers.matches ? "dark" : "light");
      prefers.addEventListener("change", (e) => applyTheme(e.matches ? "dark" : "light"));
    }
  }

  // ===== 农历 + 时辰 =====
  const DI_ZHI = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
  const SHICHEN_RANGE = ["23:00–01:00","01:00–03:00","03:00–05:00","05:00–07:00","07:00–09:00","09:00–11:00","11:00–13:00","13:00–15:00","15:00–17:00","17:00–19:00","19:00–21:00","21:00–23:00"];
  function updateLunar() {
    const el = $("lunarClock"); if (!el) return;
    if (typeof Lunar === "undefined") { el.textContent = "农历组件加载中…"; return; }
    const now = new Date(), lunar = Lunar.fromDate(now);
    const shichen = DI_ZHI[Math.floor(((now.getHours() + 1) % 24) / 2)];
    const pad = (n) => String(n).padStart(2, "0");
    el.innerHTML = `🗓 ${lunar.getYearInGanZhi()}年（${lunar.getYearShengXiao()}）${lunar.getMonthInChinese()}月${lunar.getDayInChinese()} · <strong>${shichen}时</strong> <span class="lunar-time">${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}</span>`;
    el.title = `农历时辰：${shichen}时（${SHICHEN_RANGE[Math.floor(((now.getHours() + 1) % 24) / 2)]}）`;
  }

  function updateSideClock() {
    const el = $("sideClock"); if (!el) return;
    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
    el.innerHTML = `<strong>${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}</strong> <span class="w-date">${now.getMonth() + 1}/${now.getDate()} ${wd}</span>`;
  }
  updateSideClock();
  setInterval(() => { updateLunar(); updateSideClock(); }, 1000);

  // ===== 全局交互 =====
  window.addEventListener("scroll", () => { if (backTop) backTop.classList.toggle("show", window.scrollY > 400); });
  if (backTop) backTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  if (sliderEl) { sliderEl.addEventListener("mouseenter", stopAuto); sliderEl.addEventListener("mouseleave", startAuto); }
  if (slidePrev) slidePrev.addEventListener("click", () => goSlide(currentSlide - 1));
  if (slideNext) slideNext.addEventListener("click", () => goSlide(currentSlide + 1));
  if (themeToggle) themeToggle.addEventListener("click", toggleTheme);
  const themeToggleTop = $("themeToggleTop");
  if (themeToggleTop) themeToggleTop.addEventListener("click", toggleTheme);
  const hamburgerTop = $("hamburgerTop");
  if (hamburgerTop) hamburgerTop.addEventListener("click", toggleSidebar);

  // 搜索防抖
  let searchTimer = null;
  if (searchInput) searchInput.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { searchQuery = searchInput.value.trim(); renderCards(); }, 250); });

  // 导航
  navLinks.forEach((link) => link.addEventListener("click", (e) => { e.preventDefault(); showView(link.dataset.view); window.scrollTo({ top: 0, behavior: "smooth" }); }));
  if (backBtn) backBtn.addEventListener("click", () => showView("home"));
  if (composeBack) composeBack.addEventListener("click", () => showView("home"));

  // ===== 会员会话 =====
  let currentUser = null;        // 当前登录用户（含 username），用于判断楼主
  let currentPostAuthor = "";    // 当前打开文章的作者
  let currentSlug = "";          // 当前打开文章的 slug
  let commentSort = "new";       // 评论排序：new 最新 / hot 最热
  let replyTo = 0;               // 正在回复的父评论 id（0 = 顶层新评）
  function setAuthUI(user) {
    if (user && user.username) {
      if (authBtn) authBtn.hidden = true;
      if (userChip) { userChip.hidden = false; userName.textContent = user.username; userAvatar.textContent = user.username.slice(0, 1).toUpperCase(); }
      if (publishBtnChip) publishBtnChip.hidden = false;
    } else {
      if (authBtn) authBtn.hidden = false;
      if (userChip) userChip.hidden = true;
      if (publishBtnChip) publishBtnChip.hidden = true;
    }
  }
  async function checkSession() { try { const r = await fetch("/api/me", { credentials: "same-origin" }); const d = await r.json(); currentUser = d.user; setAuthUI(d.user); return d.user; } catch (_) { currentUser = null; setAuthUI(null); return null; } }
  function openAuth(tab) { if (!authModal) return; authModal.hidden = false; switchTab(tab || "login"); if (typeof startCharInteraction === "function") startCharInteraction(); }
  function closeAuth() { if (authModal) authModal.hidden = true; if (loginMsg) loginMsg.textContent = ""; if (registerMsg) registerMsg.textContent = ""; if (typeof stopCharInteraction === "function") stopCharInteraction(); setAuthState("idle"); }
  function switchTab(tab) { document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab)); loginForm.classList.toggle("active", tab === "login"); registerForm.classList.toggle("active", tab === "register"); if (typeof switchQuote === "function") switchQuote(tab); }

  // ===== 卡通角色互动 =====
  let charStateTimer = null;
  function setAuthState(state) { if (!authModal) return; authModal.setAttribute("data-state", state); }
  function triggerState(state, holdMs = 3000) { setAuthState(state); clearTimeout(charStateTimer); charStateTimer = setTimeout(() => setAuthState("idle"), holdMs); }

  function switchQuote(tab) { const q = $("charsQuote"); if (!q) return; q.textContent = tab === "register" ? "来一起写点东西吧 ✍️" : "嗨，欢迎回来 👋"; }

  // 鼠标追踪：让每个角色的瞳孔跟随鼠标
  let charRaf = null;
  function startCharInteraction() {
    if (!authModal) return;
    document.addEventListener("mousemove", onCharMouseMove);
  }
  function stopCharInteraction() {
    document.removeEventListener("mousemove", onCharMouseMove);
    // 重置瞳孔到中心
    document.querySelectorAll(".char .pupil").forEach((p) => { p.style.transform = "translate(0,0)"; });
  }
  function onCharMouseMove(e) {
    if (!authModal || authModal.hidden) return;
    cancelAnimationFrame(charRaf);
    charRaf = requestAnimationFrame(() => {
      const mx = e.clientX, my = e.clientY;
      document.querySelectorAll(".char").forEach((ch) => {
        const eyes = ch.querySelector(".eyes");
        if (!eyes) return;
        const rect = eyes.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = mx - cx, dy = my - cy;
        const angle = Math.atan2(dy, dx);
        // 限制瞳孔偏移距离为 4px
        const dist = Math.min(4, Math.hypot(dx, dy) / 40);
        const px = Math.cos(angle) * dist;
        const py = Math.sin(angle) * dist;
        ch.querySelectorAll(".pupil").forEach((p) => { p.style.transform = `translate(${px}px, ${py}px)`; });
      });
    });
  }

  // 输入框聚焦状态切换
  function bindInputStates() {
    if (loginForm) {
      loginForm.querySelectorAll("input").forEach((inp) => {
        inp.addEventListener("focus", () => {
          const t = inp.type;
          if (t === "password") setAuthState("password");
          else if (t === "text") setAuthState("email");
        });
        inp.addEventListener("blur", () => {
          // 失焦时如果当前状态是 email/password，回到 idle
          const cur = authModal.getAttribute("data-state");
          if (cur === "email" || cur === "password") setAuthState("idle");
        });
      });
    }
    if (registerForm) {
      registerForm.querySelectorAll("input").forEach((inp) => {
        inp.addEventListener("focus", () => setAuthState("email"));
        inp.addEventListener("blur", () => { const cur = authModal.getAttribute("data-state"); if (cur === "email") setAuthState("idle"); });
      });
    }
  }
  async function handleLogin(e) {
    e.preventDefault();
    const fd = new FormData(loginForm);
    loginMsg.textContent = "登录中…"; loginMsg.className = "form-msg";
    setAuthState("loading");
    try {
      const r = await fetch("/api/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: fd.get("username"), password: fd.get("password") }) });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        loginMsg.textContent = d.error || "登录失败"; loginMsg.className = "form-msg err";
        triggerState("error", 2500);
        return;
      }
      loginMsg.textContent = "✅ 登录成功";
      loginMsg.className = "form-msg ok";
      triggerState("success", 1400);
      setTimeout(() => { setAuthUI(d.user); closeAuth(); if (currentViewIsMember()) renderMember(d.user); }, 800);
    } catch (_) {
      loginMsg.textContent = "网络错误"; loginMsg.className = "form-msg err";
      triggerState("error", 2500);
    }
  }
  async function handleRegister(e) {
    e.preventDefault();
    const fd = new FormData(registerForm);
    registerMsg.textContent = "注册中…"; registerMsg.className = "form-msg";
    setAuthState("loading");
    try {
      const r = await fetch("/api/register", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: fd.get("username"), email: fd.get("email"), password: fd.get("password") }) });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        registerMsg.textContent = d.error || "注册失败"; registerMsg.className = "form-msg err";
        triggerState("error", 2500);
        return;
      }
      registerMsg.textContent = "✅ 注册成功，已登录";
      registerMsg.className = "form-msg ok";
      triggerState("success", 1400);
      setTimeout(() => { setAuthUI(d.user); closeAuth(); if (currentViewIsMember()) renderMember(d.user); }, 800);
    } catch (_) {
      registerMsg.textContent = "网络错误"; registerMsg.className = "form-msg err";
      triggerState("error", 2500);
    }
  }
  async function handleLogout() { try { await fetch("/api/logout", { method: "POST", credentials: "same-origin" }); } catch (_) {} setAuthUI(null); if (currentViewIsMember()) renderMember(null); }
  function currentViewIsMember() { return views.member && views.member.classList.contains("active"); }
  async function renderMember(user) {
    if (!memberArea) return;
    if (!user) { memberArea.innerHTML = '<div class="member-gate"><p>登录后即可发表文章、查看会员内容。</p><button class="btn-auth" type="button" id="memberLogin">🔐 登录 / 注册</button></div>'; const b = $("memberLogin"); if (b) b.addEventListener("click", () => openAuth("login")); return; }
    memberArea.innerHTML = `<div class="member-welcome"><div class="member-card"><div class="member-avatar">${user.username.slice(0,1).toUpperCase()}</div><div><h3>欢迎，${user.username} 👋</h3><p class="member-sub">你已登录会员专区。</p></div></div><div class="member-perks"><div class="perk">✍️ 撰写并发布文章</div><div class="perk">📚 会员专享读书笔记合集</div><div class="perk">💬 文章下方专属评论区</div><div class="perk">🔖 收藏你喜欢的文章</div></div><button class="btn-publish" type="button" id="memberPublish">✍️ 现在写一篇文章</button><p class="member-note">更多功能陆续开放。</p></div>`;
    const pb = $("memberPublish"); if (pb) pb.addEventListener("click", openCompose);
  }

  // ===== 全屏写作页 =====
  function openCompose() { showView("compose"); if (composeTitle) composeTitle.value = ""; if (composeTag) composeTag.value = ""; if (composeSummary) composeSummary.value = ""; if (composeCover) composeCover.value = ""; if (composeBody) composeBody.value = ""; if (composePreview) composePreview.innerHTML = "<p style='color:var(--text-faint)'>实时预览…</p>"; if (composeMsg) composeMsg.textContent = ""; }

  // 编辑器工具栏（快捷插入 Markdown 语法）
  document.querySelectorAll(".editor-toolbar button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ta = composeBody; if (!ta) return;
      const prefix = btn.dataset.md || "";
      const suffix = btn.dataset.mdEnd || "";
      const pickMode = btn.dataset.mdPick; // "url" = popup prompt

      if (pickMode === "url") {
        const startPos = parseInt(btn.dataset.mdPickStart) || 0;
        const endPos = parseInt(btn.dataset.mdPickEnd) || 0;
        const placeholder = prefix.slice(startPos, endPos) || "https://";
        const url = prompt("请输入图片或链接地址：", placeholder);
        if (url) {
          const md = prefix.slice(0, startPos) + url + prefix.slice(endPos);
          insertAtCursor(ta, md + suffix);
        }
      } else {
        const sel = ta.value.substring(ta.selectionStart, ta.selectionEnd) || "文字";
        insertAtCursor(ta, prefix + sel + suffix + (suffix ? "" : ""));
      }
      ta.focus();
      ta.dispatchEvent(new Event("input"));
    });
  });

  // 本地图片上传：前端压缩为 base64 直接写入正文（随文章一起存进 D1，无需 R2）
  const composeImgBtn = $("composeImgUpload");
  const composeFileInput = $("composeFile");
  if (composeImgBtn && composeFileInput) {
    composeImgBtn.addEventListener("click", () => composeFileInput.click());
    composeFileInput.addEventListener("change", async () => {
      const ta = composeBody; if (!ta) return;
      const files = Array.from(composeFileInput.files || []);
      composeFileInput.value = "";
      if (!files.length) return;
      if (composeMsg) { composeMsg.textContent = `正在压缩 ${files.length} 张图片…`; composeMsg.className = "form-msg"; }
      let inserted = 0;
      for (const file of files) {
        if (!file.type.startsWith("image/")) { if (composeMsg) composeMsg.textContent = `已跳过非图片文件：${file.name}`; continue; }
        try {
          const dataUrl = await compressImage(file, 1280, 0.82);
          const name = (file.name || "image").replace(/\.[^.]+$/, "");
          insertAtCursor(ta, `\n![${name}](${dataUrl})\n`);
          inserted++;
        } catch (e) {
          if (composeMsg) { composeMsg.textContent = `「${file.name}」处理失败，可能文件过大`; composeMsg.className = "form-msg err"; }
        }
      }
      ta.focus();
      ta.dispatchEvent(new Event("input"));
      if (inserted && composeMsg) { composeMsg.textContent = `✅ 已插入 ${inserted} 张图片（已压缩存入正文）`; composeMsg.className = "form-msg ok"; }
    });
  }

  // 压缩图片：缩放到 maxW 宽、quality 质量的 JPEG，返回 data: URL（控制单图体积，避免撑爆 D1 2MB 行上限）
  function compressImage(file, maxW, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxW) { height = Math.round(height * maxW / width); width = maxW; }
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          try { resolve(canvas.toDataURL("image/jpeg", quality)); }
          catch (e) { reject(e); }
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function insertAtCursor(textarea, text) {
    const s = textarea.selectionStart, e = textarea.selectionEnd;
    textarea.value = textarea.value.slice(0, s) + text + textarea.value.slice(e);
    textarea.selectionStart = textarea.selectionEnd = s + text.length;
  }

  // 实时预览
  if (composeBody) composeBody.addEventListener("input", () => { if (composePreview) composePreview.innerHTML = mdToHtml(composeBody.value || "") || "<p style='color:var(--text-faint)'>实时预览…</p>"; });

  // 废弃旧弹窗（由全屏写作页替代）
  const composeModal = $("composeModal"); if (composeModal) composeModal.remove();

  async function handlePublish() {
    const title = (composeTitle?.value || "").trim();
    const body = (composeBody?.value || "").trim();
    if (!title || !body) { if (composeMsg) { composeMsg.textContent = "标题和正文不能为空"; composeMsg.className = "form-msg err"; } return; }
    if (composeMsg) { composeMsg.textContent = "发布中…"; composeMsg.className = "form-msg"; }
    if (composeSubmit) composeSubmit.disabled = true;
    try {
      const res = await fetch("/api/posts", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, tag: (composeTag?.value || "").trim(), summary: (composeSummary?.value || "").trim(), cover: (composeCover?.value || "").trim(), body }) });
      const data = await res.json();
      if (!res.ok || !data.ok) { if (composeMsg) { composeMsg.textContent = data.error || "发布失败"; composeMsg.className = "form-msg err"; } return; }
      if (composeMsg) { composeMsg.innerHTML = "✅ 已发布"; composeMsg.className = "form-msg ok"; }
      setTimeout(() => { showView("home"); loadPosts(); }, 800);
    } catch (_) { if (composeMsg) { composeMsg.textContent = "网络错误"; composeMsg.className = "form-msg err"; } } finally { if (composeSubmit) composeSubmit.disabled = false; }
  }

  // ===== 移动端汉堡菜单 =====
  function toggleSidebar() { const open = sidebar?.classList.toggle("open"); if (sidebarOverlay) sidebarOverlay.hidden = !open; document.body.style.overflow = open ? "hidden" : ""; }
  if (hamburger) hamburger.addEventListener("click", toggleSidebar);
  if (sidebarOverlay) sidebarOverlay.addEventListener("click", toggleSidebar);
  if (mainNav) mainNav.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => { if (sidebar) sidebar.classList.remove("open"); if (sidebarOverlay) sidebarOverlay.hidden = true; document.body.style.overflow = ""; }));

  // ===== 事件绑定 =====
  if (authBtn) authBtn.addEventListener("click", () => openAuth("login"));
  if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);
  if (authClose) authClose.addEventListener("click", closeAuth);
  if (authModal) authModal.addEventListener("click", (e) => { if (e.target === authModal) closeAuth(); });
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  if (loginForm) loginForm.addEventListener("submit", handleLogin);
  if (registerForm) registerForm.addEventListener("submit", handleRegister);
  if (publishBtnChip) publishBtnChip.addEventListener("click", openCompose);
  if (composeSubmit) composeSubmit.addEventListener("click", handlePublish);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && authModal && !authModal.hidden) closeAuth(); });

  const memberNav = document.querySelector('.nav-link[data-view="member"]');
  if (memberNav) memberNav.addEventListener("click", async () => { const user = await checkSession(); renderMember(user); });

  // ===== 启动 =====
  updateLunar();
  setInterval(updateLunar, 1000);
  bindInputStates();
  checkSession();
  loadPosts();
})();