// ===== 昉昕的博客 — 前端交互 =====
(function () {
  // IIFE 已开始执行即视为脚本启动成功；index.html 的 6s 兜底检测据此判断是否误报。
  // 放在最前面，避免后续任何同步/异步延迟让诊断横幅错误弹出。
  window.__APP_BOOTED__ = true;

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
    guestbook: document.querySelector(".view-guestbook"),
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

  // ── 规范化站点源：分享/复制链接一律用 canonical 域名，避免把过期或别名域名传播出去 ──
  const SITE_ORIGIN = (() => {
    const c = document.querySelector('link[rel="canonical"]');
    try { return c ? new URL(c.href).origin : location.origin; } catch { return location.origin; }
  })();

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
  let currentSlide = 0, totalSlides = 0, slideTimer = null, hoverPaused = false;
  let searchQuery = "";
  let tocScrollHandler = null;
  // 当前登录用户（含 username），用于判断楼主 / 留言墙署名。
  // 注意：必须在此处声明（IIFE 顶部），否则 bindGuestbookForm() 等早期执行的代码
  // 会因 let 的暂时性死区（TDZ）抛 ReferenceError，中断整个脚本初始化。
  let currentUser = null;
  let sessionReady = false;       // 会话已校验过则不再每次打开文章都请求 /api/me
  const postCache = new Map();    // 文章详情客户端缓存：slug -> post，避免重复打开重复拉取大体积正文

  // ===== Markdown → HTML =====
  function mdToHtml(md) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    function inline(text) {
      return esc(text)
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" decoding="async">')
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
        const lang = line.slice(3).trim().split(/\s+/)[0] || "";
        const code = []; i++;
        while (i < lines.length && !lines[i].startsWith("```")) { code.push(lines[i]); i++; }
        i++; html += `<pre><code class="language-${lang}">${esc(code.join("\n"))}</code></pre>`; continue;
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

  // 有 base64 内联图的文章：先占位、进入视口再回填真实 src，避免首屏同步解码卡顿
  const IMG_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='3'%3E%3C/svg%3E";
  let imgObserver = null;
  function getImgObserver() {
    if (imgObserver) return imgObserver;
    if (!("IntersectionObserver" in window)) return null;
    imgObserver = new IntersectionObserver((entries, obs) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const img = e.target;
        const real = img.dataset.src;
        if (real) {
          img.src = real;
          img.removeAttribute("data-src");
          img.addEventListener("load", () => img.classList.remove("img-lazy"), { once: true });
        }
        obs.unobserve(img);
      });
    }, { rootMargin: "300px 0px" });
    return imgObserver;
  }
  function lazyLoadImages(container) {
    if (!container) return;
    const obs = getImgObserver();
    container.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (!src.startsWith("data:image")) return; // 仅处理 base64 内联图，外链图交给浏览器原生 lazy
      if (img.dataset.src) return;               // 已处理过则跳过
      img.dataset.src = src;
      img.src = IMG_PLACEHOLDER;
      img.classList.add("img-lazy");
      if (obs) obs.observe(img);
      else { img.src = img.dataset.src; img.removeAttribute("data-src"); img.classList.remove("img-lazy"); }
    });
  }

  function formatDate(d) { const [y, m, day] = d.split("-"); return `${y}年${Number(m)}月${Number(day)}日`; }
  function gradFor(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360; return `linear-gradient(135deg, hsl(${h},46%,68%), hsl(${(h + 38) % 360},44%,54%))`; }
  // 无封面卡片统一奶油玻璃底色（不用 gradFor 彩色，避免"色块"感）
  function glassBg(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360; const t = 20 + (h % 2) * 8; return `linear-gradient(135deg, hsl(${h},${t}%,92%), hsl(${(h + 30) % 360},${t}%,86%))`; }
  function coverStyle(p) { return p.cover ? `background-image:url('${p.cover}');` : `background:${glassBg(p.title)};`; }

  // ===== 数据 =====
  // 动态列表：直查 D1 的 Function 接口（静态快照不可用或已过期时使用）
  // 带超时与缓存策略的 JSON 请求：跨境网络慢/抖时快速失败并走降级路径，避免「正在加载」永久卡死。
  async function fetchJSON(url, { cache = "no-store", timeout = 6000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { credentials: "same-origin", cache, signal: ctrl.signal });
      if (!res.ok) throw new Error(url + " " + res.status);
      return res;
    } finally { clearTimeout(timer); }
  }

  async function fetchDynamicPosts() {
    const res = await fetchJSON("/api/posts", { cache: "no-store", timeout: 6000 });
    const data = await res.json();
    if (!data.ok) throw new Error("bad list");
    return data.posts || [];
  }

  // 静态快照新鲜度自检：generated/posts.json 是构建期产物，无法感知数据库后续新增。
  // 一旦 Deploy Hook 未生效或部署延迟，快照会长期停留在旧版本 —— 新文章进了 D1 却显示不出来。
  // 这里用极轻量的 /api/posts/meta（count + 最新 slug）比对，过期则回调刷新，且不阻塞首屏。
  async function verifyStaticFreshness(meta, onStale) {
    // 旧格式快照没有 count 字段。若在这里直接 return，就等于放弃校验 ——
    // 结果是一直使用过期列表，新发布的文章永远显示不出来。
    // 放宽处理：count 缺失就改用 latest 比对；两者都缺失说明快照不可信，直接刷新一次。
    const hasCount = !!(meta && typeof meta.count === "number");
    const hasLatest = !!(meta && typeof meta.latest === "string" && meta.latest);
    if (!hasCount && !hasLatest) {
      try { await onStale(); } catch (_) {}
      return;
    }
    try {
      const r = await fetchJSON("/api/posts/meta", { cache: "no-store", timeout: 5000 });
      const d = await r.json();
      if (!d || !d.ok) return;
      const stale =
        (hasCount && d.count !== meta.count) ||
        (hasLatest && d.latest && meta.latest !== d.latest);
      if (stale) await onStale();
    } catch (_) {}
  }

  async function fetchAllPosts() {
    // 静态预渲染优先：CDN 直读 /generated/posts.json（构建时生成）。
    // 用 cache:"force-cache" 让浏览器直接命中本地缓存秒开首屏（跨境刷新也不依赖网络）；
    // 后台再由 verifyStaticFreshness 用 /api/posts/meta 校验新鲜度并静默补最新文章。
    // 304（本地缓存有效、响应体为空）也视为命中、安全回退动态接口，避免白屏。
    try {
      const sres = await fetchJSON("/generated/posts.json", { cache: "force-cache", timeout: 8000 });
      // 304 表示本地缓存的静态快照仍有效（但响应体为空），此时回退动态接口；
      // 200 则正常解析。两者都视为「静态命中」，避免把 304 误判为失败导致白屏。
      if (sres.ok || sres.status === 304) {
        if (sres.ok) {
          const sd = await sres.json();
          if (sd && sd.ok && Array.isArray(sd.posts)) {
            // 先用静态列表秒开首屏，再后台校验快照是否过期；有新文章则静默补上
            verifyStaticFreshness({ count: sd.count, latest: sd.latest }, async () => {
              try {
                const fresh = await fetchDynamicPosts();
                if (fresh && fresh.length) refreshHomeList(fresh);
              } catch (_) {}
            });
            return sd.posts;
          }
        }
      }
    } catch (_) {}
    return fetchDynamicPosts();
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
  function startAuto() { if (hoverPaused) return; stopAuto(); slideTimer = setInterval(() => goSlide(currentSlide + 1), 5000); }
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

  // 卡片分页：先渲染一页，剩余用「加载更多」增量展示
  let pageList = [];
  let pageCount = 0;
  const PAGE_SIZE = 9;

  function cardHtml(p, i) {
    return `
      <article class="card ${i === 0 ? "feature" : i === 1 ? "wide" : ""}" data-slug="${escapeHtml(p.slug)}">
        <div class="card-cover ${p.cover ? "" : "no-img"}" style="background:${p.cover ? "" : glassBg(p.title)};">
          ${p.cover ? `<img class="card-cover-img" src="${escapeHtml(p.cover)}" loading="lazy" decoding="async" alt="">` : `<div class="cover-empty" aria-hidden="true"></div>`}
        </div>
        <div class="card-body">
          <div class="card-meta"><span class="tag">${escapeHtml(p.tag)}</span><span>${formatDate(p.date)}</span><span>✍ ${escapeHtml(p.author)}</span></div>
          <h3>${escapeHtml(p.title)}</h3><p>${escapeHtml(p.summary || "")}</p>
          <div class="card-foot"><span>⏱ 约 ${p.readingMinutes || readingTime(p.summary || p.title).minutes} 分钟 · ${p.words || 0} 字 · ${p.views || 0} 阅读</span><span class="card-go">阅读 →</span></div>
        </div></article>`;
  }

  // 卡片滚动入场动画：首次进入视口时由小变大淡入；unobserve 后不再反复触发，避免边界闪动
  let cardObserver = null;
  if ("IntersectionObserver" in window) {
    cardObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in-view");
            cardObserver.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -24px 0px" }
    );
  }
  function revealCards(root) {
    (root || document).querySelectorAll(".card").forEach((el) => {
      if (cardObserver) cardObserver.observe(el);
      else { el.classList.add("in-view"); }
    });
  }

  function paintCards() {
    const slice = pageList.slice(0, pageCount);
    if (!slice.length) {
      cardGrid.innerHTML = `<p style="color:var(--text-faint);grid-column:1/-1;">${searchQuery ? "没有匹配「" + escapeHtml(searchQuery) + "」的文章。" : "该分类下暂无文章。"}</p>`;
      return;
    }
    const more = pageList.length - slice.length;
    cardGrid.innerHTML =
      slice.map((p, i) => cardHtml(p, i)).join("") +
      (more > 0 ? `<button class="load-more" id="loadMore" type="button">加载更多（还剩 ${more} 篇）</button>` : "");
    cardGrid.querySelectorAll(".card").forEach((el) => el.addEventListener("click", () => openPost(el.dataset.slug)));
    const lm = $("loadMore");
    if (lm) lm.addEventListener("click", () => { pageCount += PAGE_SIZE; paintCards(); });
    revealCards(cardGrid);
  }

  function renderCardsFrom(list) {
    pageList = list || [];
    pageCount = PAGE_SIZE;
    paintCards();
  }

  function renderCards() {
    // 本地筛选（按标题+摘要）；切分类/回首页时清掉搜索态
    searchQuery = "";
    if (searchInput) searchInput.value = "";
    renderCardsFrom(getFiltered());
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
      let post = postCache.get(slug);
      let fromStatic = false;
      if (!post) {
        // 静态预渲染优先：CDN 直读 /generated/posts/<slug>.json（含 body，秒回）；
        // 缺失/失败则降级到 Function 动态接口。
        try {
          const sres = await fetchJSON(`/generated/posts/${encodeURIComponent(slug)}.json`, { cache: "force-cache", timeout: 8000 });
          // 304 视为静态命中（无 body），回退下方动态接口；200 正常解析
          if (sres.ok || sres.status === 304) {
            if (sres.ok) {
              const sd = await sres.json();
              if (sd && sd.ok && sd.post) { post = sd.post; fromStatic = true; }
            }
          }
        } catch (_) {}
        if (!post) {
          const res = await fetch("/api/posts/detail", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) });
          const data = await res.json();
          if (!res.ok || !data.ok || !data.post) { postDetail.innerHTML = `<p style="color:var(--text-faint)">文章加载失败：${(data && data.error) || res.status}</p>`; return; }
          post = data.post;
        }
        postCache.set(slug, post);
      }
      updateMeta(post);
      if (!sessionReady) { currentUser = await checkSession(); sessionReady = true; }
      // 静态快照无法判断作者，按当前会话修正，保证作者看到编辑/删除按钮
      post.isAuthor = !!(currentUser && currentUser.username && post.author && (currentUser.username === post.author || currentUser.isOwner));
      // 静态加载未经过 detail.js 的 +1 逻辑，这里补一次实时阅读数（非作者才 +1）
      if (fromStatic) {
        try {
          const vres = await fetch("/api/posts/view", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) });
          const vd = await vres.json();
          if (vd && vd.ok) post.views = vd.views;
        } catch (_) {}
      }
      currentSlug = slug;
      currentPost = post;
      currentPostAuthor = post.author;
      const isAuthor = !!post.isAuthor;
      const manageBtns = isAuthor
        ? `<span class="post-actions"><button class="post-edit" data-edit-slug="${escapeHtml(slug)}" type="button">✏️ 编辑</button><button class="post-del" data-del-slug="${escapeHtml(slug)}" type="button">🗑 删除</button></span>`
        : "";
      const rt = { minutes: post.readingMinutes || 0, words: post.words || 0 };
      const hero = post.cover ? `<img class="post-cover" src="${post.cover}" alt="">` : "";
      const toc = buildToc(post.body || "");
      const tocHtml = toc.length ? `<nav class="toc"><div class="toc-title">📑 目录</div><ul class="toc-list">${toc.map((t) => `<li class="toc-l${t.level}"><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`).join("")}</ul></nav>` : "";
      const shareUrl = SITE_ORIGIN + location.pathname + "?post=" + encodeURIComponent(slug);
      const shareBtns = `<div class="post-share"><button class="share-btn" data-share="copy" data-url="${escapeHtml(shareUrl)}" type="button">📋 复制链接</button><button class="share-btn" data-share="native" data-url="${escapeHtml(shareUrl)}" type="button">📤 分享</button></div>`;
      const nav = buildPostNav(slug);
      postDetail.innerHTML = `<div class="post-meta"><span class="tag">${post.tag}</span><span>${formatDate(post.date)}</span><span class="author">✍ ${post.author}</span><span class="read-time">⏱ 约 ${rt.minutes} 分钟 · ${rt.words} 字 · ${post.views || 0} 阅读</span>${manageBtns}</div>${hero}<h2>${post.title}</h2>${shareBtns}${tocHtml}<div class="post-body">${mdToHtml(post.body || "")}</div>${nav}<section class="comments" id="comments"><div class="comments-head"><h3 class="comments-title">💬 评论</h3><div class="comment-sort"><button class="sort-btn active" data-sort="new" type="button">最新</button><button class="sort-btn" data-sort="hot" type="button">最热</button></div></div><div class="comment-list" id="commentList"><p class="comments-loading">加载评论中…</p></div><div class="reply-hint" id="replyHint" hidden>回复 <b id="replyName"></b><button type="button" id="replyCancel" class="reply-cancel" title="取消回复">✕</button></div><form class="comment-form" id="commentForm"><textarea class="comment-input" id="commentInput" placeholder="说点什么…" maxlength="2000"></textarea><div class="comment-actions"><span class="comment-msg" id="commentMsg"></span><button class="btn-submit" type="submit">发表评论</button></div></form></section>`;
      lazyLoadImages(postDetail);
      bindCommentForm(slug);
      loadComments(slug);
      addCodeCopyButtons();
      // 仅当文章含代码块时才懒加载 highlight.js（122KB），并放到绘制之后执行，先让正文可见
      if (postDetail.querySelector("pre code")) ensureHljs().then(() => highlightCodeBlocks(postDetail)).catch(() => {});
      initReadingProgress();
      initTocSpy();
      // ① 文章详情进入动画：重播子元素错位淡入
      postDetail.classList.remove("post-anim"); void postDetail.offsetWidth; postDetail.classList.add("post-anim");
    } catch (_) { postDetail.innerHTML = `<p style="color:var(--text-faint)">文章加载失败，请重试</p>`; }
  }

  // ===== 工具函数 =====
  function escapeHtml(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function readingTime(md) {
    const text = (md || "").replace(/!\[[^\]]*\]\([^)]+\)/g, "").replace(/[#*`\[\](){}|>\-]/g, "");
    const cjkChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const nonCjkWords = text.replace(/[\u4e00-\u9fa5]/g, " ").trim().split(/\s+/).filter((x) => x).length;
    const words = cjkChars + nonCjkWords;
    return { words, minutes: Math.max(1, Math.round(words / 300)) };
  }
  function sharePost(post) {
    const url = SITE_ORIGIN + location.pathname + "?post=" + encodeURIComponent(post.slug);
    const text = `看看这篇文章：${post.title}`;
    if (navigator.share) {
      navigator.share({ title: post.title, text, url }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => alert("文章链接已复制到剪贴板")).catch(() => {});
    }
  }

  // ===== 动态 meta / OG 标签（分享卡片用）=====
  function setMeta(name, content, isProperty) {
    const attr = isProperty ? "property" : "name";
    let el = document.head.querySelector(`meta[${attr}="${name}"]`);
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute(attr, name);
      document.head.appendChild(el);
    }
    el.setAttribute("content", content);
  }

  function updateMeta(post) {
    const url = SITE_ORIGIN + location.pathname + "?post=" + encodeURIComponent(post.slug);
    const rawDesc = (post.summary || "").trim() || (post.body || "").replace(/[#>*`\-!\[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
    document.title = post.title + " · 昉昕的博客";
    setMeta("description", rawDesc, false);
    setMeta("og:type", "article", true);
    setMeta("og:site_name", "昉昕的博客", true);
    setMeta("og:title", post.title, true);
    setMeta("og:description", rawDesc, true);
    setMeta("og:url", url, true);
    if (post.cover) setMeta("og:image", post.cover, true);
    setMeta("twitter:card", post.cover ? "summary_large_image" : "summary", true);
    setMeta("twitter:title", post.title, true);
    setMeta("twitter:description", rawDesc, true);
    if (post.cover) setMeta("twitter:image", post.cover, true);
  }

  function resetMeta() {
    document.title = "昉昕的博客 · 记录与思考";
    setMeta("description", "昉昕的个人博客，记录技术实践、读书笔记与生活思考。", false);
    ["og:type", "og:site_name", "og:title", "og:description", "og:url", "og:image", "twitter:card", "twitter:title", "twitter:description", "twitter:image"].forEach((k) => {
      const el = document.head.querySelector(`meta[${k.startsWith("og:") || k.startsWith("twitter:") ? "property" : "name"}="${k}"]`);
      if (el) el.remove();
    });
  }

  // 目录滚动高亮（scroll-spy）：滚动时高亮当前章节对应的目录项
  function initTocSpy() {
    if (tocScrollHandler) { window.removeEventListener("scroll", tocScrollHandler); tocScrollHandler = null; }
    const links = Array.from(postDetail.querySelectorAll(".toc-list a"));
    if (!links.length) return;
    const map = links
      .map((a) => {
        const id = a.getAttribute("href").slice(1);
        const h = postDetail.querySelector("#" + (window.CSS && CSS.escape ? CSS.escape(id) : id));
        return { a, h };
      })
      .filter((x) => x.h);
    if (!map.length) return;
    const onScroll = () => {
      let active = map[0];
      for (const x of map) {
        if (x.h.getBoundingClientRect().top <= 90) active = x;
        else break;
      }
      map.forEach((x) => x.a.classList.toggle("active", x === active));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    tocScrollHandler = onScroll;
    onScroll();
  }

  // 构建上一篇/下一篇/相关文章导航
  function buildPostNav(currentSlug) {
    const idx = posts.findIndex((p) => p.slug === currentSlug);
    if (idx < 0) return "";
    const prev = posts[idx + 1];
    const next = posts[idx - 1];
    const current = posts[idx];
    const related = posts.filter((p, i) => i !== idx && p.tag === current.tag).slice(0, 3);
    let html = '<nav class="post-nav">';
    html += '<div class="post-nav-row">';
    html += prev ? `<a class="post-nav-item prev" href="?post=${encodeURIComponent(prev.slug)}" data-slug="${escapeHtml(prev.slug)}"><span>← 上一篇</span><strong>${escapeHtml(prev.title)}</strong></a>` : '<span class="post-nav-item disabled"><span>← 上一篇</span><strong>没有了</strong></span>';
    html += next ? `<a class="post-nav-item next" href="?post=${encodeURIComponent(next.slug)}" data-slug="${escapeHtml(next.slug)}"><span>下一篇 →</span><strong>${escapeHtml(next.title)}</strong></a>` : '<span class="post-nav-item disabled"><span>下一篇 →</span><strong>没有了</strong></span>';
    html += '</div>';
    if (related.length) {
      html += '<div class="post-related"><div class="post-related-title">📎 相关文章</div><div class="post-related-list">';
      html += related.map((p) => `<a class="post-related-item" href="?post=${encodeURIComponent(p.slug)}" data-slug="${escapeHtml(p.slug)}"><span class="related-tag">${escapeHtml(p.tag)}</span><strong>${escapeHtml(p.title)}</strong></a>`).join("");
      html += '</div></div>';
    }
    html += '</nav>';
    return html;
  }

  function addCodeCopyButtons() {
    postDetail.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".code-copy")) return;
      const btn = document.createElement("button");
      btn.className = "code-copy";
      btn.type = "button";
      btn.textContent = "复制";
      btn.addEventListener("click", async () => {
        const code = pre.querySelector("code");
        const text = code ? code.innerText : pre.innerText;
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = "已复制";
          btn.classList.add("copied");
          setTimeout(() => { btn.textContent = "复制"; btn.classList.remove("copied"); }, 1800);
        } catch (_) { btn.textContent = "失败"; setTimeout(() => btn.textContent = "复制", 1200); }
      });
      pre.style.position = "relative";
      pre.appendChild(btn);
    });
  }

  // 代码高亮：文章渲染后对 .post-body 内的 <pre><code> 应用 highlight.js
  function highlightCodeBlocks(container) {
    if (!window.hljs || !container) return;
    container.querySelectorAll("pre code").forEach((el) => {
      try {
        const m = (el.className || "").match(/language-([\w-]+)/);
        if (m && m[1]) {
          if (!el.dataset.hl) { window.hljs.highlightElement(el); el.dataset.hl = "1"; }
        } else {
          // 无语言标注：调用自动识别（highlight.js v11 对无语言元素不会自动高亮）
          const res = window.hljs.highlightAuto(el.textContent);
          el.innerHTML = res.value;
          el.classList.add("hljs");
        }
      } catch (_) {}
    });
  }

  // 按需懒加载 highlight.js（仅当文章含代码块时），避免首页/无代码页无谓加载 122KB
  let hljsLoading = null;
  function ensureHljs() {
    if (window.hljs) return Promise.resolve();
    if (hljsLoading) return hljsLoading;
    hljsLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "assets/vendor/highlight.min.js";
      s.onload = () => resolve();
      s.onerror = () => { hljsLoading = null; reject(new Error("hljs load failed")); };
      document.head.appendChild(s);
    });
    return hljsLoading;
  }

  function initReadingProgress() {
    let bar = $("readProgress");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "readProgress";
      bar.className = "read-progress";
      document.body.appendChild(bar);
    }
    const body = postDetail.querySelector(".post-body");
    if (!body) { bar.style.width = "0%"; return; }
    const update = () => {
      const rect = body.getBoundingClientRect();
      const total = body.offsetHeight + rect.top;
      const scrolled = Math.max(0, -rect.top);
      const pct = Math.min(100, Math.max(0, (scrolled / total) * 100));
      bar.style.width = pct + "%";
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
  }

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
      const name = (currentUser && currentUser.username ? currentUser.username : "匿名").trim();
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
    const editBtn = e.target.closest(".post-edit");
    if (editBtn) {
      e.preventDefault();
      const s = editBtn.dataset.editSlug;
      if (currentPost && currentPost.slug === s) {
        openCompose(currentPost);
      } else {
        // 兜底：从列表项进入时可能还没完整 body，先取详情再编辑
        try {
          const res = await fetch("/api/posts/detail", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: s }) });
          const data = await res.json();
          if (data.ok && data.post) openCompose(data.post);
        } catch (_) {}
      }
      return;
    }
    const postDelBtn = e.target.closest(".post-del");
    if (postDelBtn) {
      e.preventDefault();
      handleDeletePost(postDelBtn.dataset.delSlug);
      return;
    }
    const shareBtn = e.target.closest(".share-btn");
    if (shareBtn) {
      e.preventDefault();
      const url = shareBtn.dataset.url;
      if (shareBtn.dataset.share === "copy" && navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => { shareBtn.textContent = "✅ 已复制"; setTimeout(() => shareBtn.textContent = "📋 复制链接", 1800); }).catch(() => {});
      } else if (shareBtn.dataset.share === "native" && currentPost) {
        sharePost(currentPost);
      }
      return;
    }
    const navLink = e.target.closest(".post-nav-item[data-slug], .post-related-item[data-slug]");
    if (navLink) {
      e.preventDefault();
      const s = navLink.dataset.slug;
      if (s) { history.replaceState(null, "", "?post=" + encodeURIComponent(s)); openPost(s); }
      return;
    }
  });
  async function handleLike(btn) {
    const id = btn.dataset.like;
    if (!id || localStorage.getItem("liked:" + id)) { btn.classList.add("liked"); return; }
    try {
      const res = await fetch("/api/posts/comments", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "like", slug: currentSlug, id: Number(id) }) });
      const data = await res.json();
      if (data.ok) {
        localStorage.setItem("liked:" + id, "1");
        btn.classList.add("liked");
        const span = btn.querySelector(".like-count"); if (span) span.textContent = data.likes;
        // ④ 点赞爆裂动效
        btn.classList.remove("pop"); void btn.offsetWidth; btn.classList.add("pop");
        for (let i = 0; i < 6; i++) {
          const p = document.createElement("span");
          p.className = "like-burst";
          const ang = (Math.PI * 2 / 6) * i;
          p.style.setProperty("--bx", Math.cos(ang) * 22 + "px");
          p.style.setProperty("--by", Math.sin(ang) * 22 + "px");
          btn.appendChild(p);
          setTimeout(() => p.remove(), 600);
        }
      }
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
    if (name === "home") resetMeta();
    if (name === "guestbook") loadGuestbook();
    Object.values(views).forEach((v) => v.classList.remove("active"));
    if (views[name]) views[name].classList.add("active");
    navLinks.forEach((l) => l.classList.toggle("active", l.dataset.view === name));
    // close mobile sidebar on nav
    if (sidebar) sidebar.classList.remove("open");
    if (sidebarOverlay) sidebarOverlay.hidden = true;
    document.body.style.overflow = "";
  }

  // 用新列表静默重渲染首页（静态快照过期后补上最新文章，不打断用户浏览、不显示加载态）
  function refreshHomeList(list) {
    try {
      posts = list.map((p) => ({ ...p, summary: p.summary || (p.title || "").replace(/[#>*`\-\s]/g, " ").slice(0, 80).trim() }));
      renderSlider(); renderFilters(); renderCards(); renderArchive(); renderWidgets();
    } catch (_) {}
  }

  async function loadPosts() {
    cardGrid.innerHTML = Array.from({ length: 4 }).map(() => '<div class="sk-card"><div class="sk-cover skeleton"></div><div class="sk-line skeleton"></div><div class="sk-line short skeleton"></div></div>').join("");
    if (sliderEl) sliderEl.style.display = "block";
    // 看门狗：跨境网络极端抖动导致 8s 仍未返回时，提示手动重试，而非永久停留在「正在加载」
    const watchdog = setTimeout(() => {
      if (!posts || !posts.length) {
        cardGrid.innerHTML = `<p style="color:var(--text-faint)">加载较慢，可能是跨境网络延迟。<button id="retryPosts" style="margin-left:8px;cursor:pointer">重试</button></p>`;
        const btn = document.getElementById("retryPosts");
        if (btn) btn.addEventListener("click", loadPosts);
      }
    }, 8000);
    try {
      const list = await fetchAllPosts();
      clearTimeout(watchdog);
      posts = list.map((p) => ({ ...p, summary: p.summary || (p.title || "").replace(/[#>*`\-\s]/g, " ").slice(0, 80).trim() }));
    } catch (e) {
      clearTimeout(watchdog);
      cardGrid.innerHTML = `<p style="color:var(--text-faint)">文章加载失败：${e.message}<button id="retryPosts" style="margin-left:8px;cursor:pointer">重试</button></p>`;
      if (sliderEl) sliderEl.style.display = "none";
      const btn = document.getElementById("retryPosts");
      if (btn) btn.addEventListener("click", loadPosts);
      return;
    }
    if (!posts.length) { clearTimeout(watchdog); cardGrid.innerHTML = `<p style="color:var(--text-faint)">暂无文章。</p>`; return; }
    renderSlider(); renderFilters(); renderCards(); renderArchive(); renderWidgets();
  }

  // ===== 留言墙（便签墙 / 感恩日记）=====
  // 公开功能：游客可写（可选名字 + 200 字以内），站长可删（BLOG_OWNER）。
  // 设计：第一次进入视图才加载（lazy），之后用模块变量标记已加载；提交 / 删除均在前端即时更新，无需刷新。
  let guestbookLoaded = false;
  let guestbookCanDelete = false;
  let turnstileSiteKey = null;   // 后端下发，未配置时不启用
  let turnstileWidgetId = null;  // 留言墙 Turnstile widget 实例 id
  let registerWidgetId = null;   // 注册表单 Turnstile widget 实例 id
  let guestNextCursor = null;    // 下一页游标 { before, before_id }
  let guestHasMore = false;      // 是否还有更早的便签
  let guestbookMineIds = new Set(); // 本机（localStorage）记录自己写过的便签 id（优化 #7）
  let guestbookCurrentUser = null;  // 当前登录用户名（来自 /api/guestbook 返回；已登录则隐藏「你的名字」栏）
  const MINE_LS_KEY = "guestbook_mine";

  // 与后端保持一致的色板（前端也用一份作为兜底）
  const GB_G_ICON = { blue: "🌸", pink: "💗", yellow: "⭐", purple: "🌙", green: "🌿", orange: "🍂", mint: "❄️" };

  function formatGuestDate(s) {
    // "2026-09-02 18:30" -> "2026.09.02  18:30"
    if (!s) return "";
    const [d, t] = s.split(" ");
    return `${(d || "").replace(/-/g, ".")}  ${t || ""}`;
  }

  function buildGuestCard(n) {
    const canDel = guestbookCanDelete;
    const icon = GB_G_ICON[n.color] || "🌷";
    const mine = guestbookMineIds.has(Number(n.id));
    return `<article class="g-card g-card-${escapeHtml(n.color)}${mine ? " g-mine" : ""}" data-id="${n.id}">
      <span class="g-pin" aria-hidden="true"></span>
      ${mine ? `<span class="g-mine-badge" title="这是你写过的便签">我的</span>` : ""}
      <div class="g-content">${escapeHtml(n.content)}</div>
      <div class="g-meta">
        <span class="g-icon">${icon}</span>
        <span class="g-date">${escapeHtml(formatGuestDate(n.created_at))}</span>
        <span class="g-name">— ${escapeHtml(n.name || "匿名")}</span>
      </div>
      ${canDel ? `<button class="g-del" type="button" data-del="${n.id}" aria-label="删除便签">×</button>` : ""}
    </article>`;
  }

  // ===== 优化 #7：「我的便签」本地记忆 =====
  // 用 localStorage 记住自己写过的便签 id，渲染时显示小徽章。
  // 失败（隐私模式 / quota）静默：徽章本来就是锦上添花。
  function loadMineIds() {
    try {
      const raw = localStorage.getItem(MINE_LS_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) guestbookMineIds = new Set(arr.map(Number).filter(Number.isFinite));
    } catch (_) { /* 忽略：隐私模式 / 损坏数据 */ }
  }
  function saveMineIds() {
    try { localStorage.setItem(MINE_LS_KEY, JSON.stringify(Array.from(guestbookMineIds))); }
    catch (_) { /* 忽略：隐私模式 / quota */ }
  }
  function addMineId(id) {
    const n = Number(id);
    if (!Number.isFinite(n)) return;
    if (guestbookMineIds.has(n)) return;
    guestbookMineIds.add(n);
    saveMineIds();
  }
  function removeMineId(id) {
    const n = Number(id);
    if (!guestbookMineIds.has(n)) return;
    guestbookMineIds.delete(n);
    saveMineIds();
  }

  // UTC+8 下的"今天 / N 天前"，格式 YYYY-MM-DD
  function gbTodayStr(offsetDays) {
    const d = new Date(Date.now() + 8 * 3600 * 1000 - (offsetDays || 0) * 86400000);
    const pad = (x) => String(x).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  // 按日期分组：今天 / 昨天 / 具体日期 —— 像翻日记本，而不是一堆散卡
  function groupNotesByDate(notes) {
    const todayStr = gbTodayStr(0);
    const yStr = gbTodayStr(1);
    const order = [];
    const map = new Map();
    (notes || []).forEach((n) => {
      const d = (n.created_at || "").slice(0, 10);
      if (!map.has(d)) { map.set(d, []); order.push(d); }
      map.get(d).push(n);
    });
    return order.map((d) => ({
      date: d,
      label: d === todayStr ? "今天" : d === yStr ? "昨天" : d.replace(/-/g, "."),
      items: map.get(d),
    }));
  }

  // 顶部统计：连续打卡天数 + 便签总数
  function renderGuestStats(total, streak) {
    const box = $("guestbookStats");
    if (!box) return;
    const t = $("gbTotal");
    const s = $("gbStreak");
    if (t) t.textContent = String(total || 0);
    if (s) s.textContent = String(streak || 0);
    box.hidden = false;
  }

  // 已登录时隐藏「你的名字」栏并提示「以 X 署名」；未登录则反之。
  // 由 bindGuestbookForm 初始化时 + setAuthUI 状态变更时调用，保证登录/登出即时同步。
  function updateGuestbookAuthHint() {
    const wrap = $("guestNameWrap");
    const input = $("guestName");
    const hint = $("guestbookAuthHint");
    if (!wrap || !input || !hint) return;
    const u = currentUser && currentUser.username ? currentUser.username : null;
    if (u) {
      wrap.hidden = true;
      input.value = "";
      hint.hidden = false;
      hint.textContent = `将以「${u}」署名（已登录）`;
    } else {
      wrap.hidden = false;
      hint.hidden = true;
      hint.textContent = "";
    }
  }

  function renderGuestbook(notes, opts) {
    const board = $("guestbookBoard");
    if (!board) return;
    const append = !!(opts && opts.append);
    if (!notes || !notes.length) {
      if (!append) board.innerHTML = `<p style="color:var(--text-faint);text-align:center;padding:32px 0">还没有便签 —— 来写第一张吧 ☕️</p>`;
      return;
    }
    // 追加时去掉可能存在的"还没有便签"占位
    if (append) {
      const placeholder = board.querySelector("p");
      if (placeholder) placeholder.remove();
      // 去掉"加载更多"按钮区域，准备重建
      const more = board.querySelector(".g-load-more");
      if (more) more.remove();
    }
    const groups = groupNotesByDate(notes);
    const html = groups
      .map(
        (g) => `
        <div class="g-group" data-date="${escapeHtml(g.date)}">
          <div class="g-group-head">
            <span class="g-group-label">${escapeHtml(g.label)}</span>
            <span class="g-group-count">${g.items.length} 张</span>
          </div>
          <div class="g-board-inner">${g.items.map(buildGuestCard).join("")}</div>
        </div>
      `
      )
      .join("");
    if (append) {
      // 追加分组：相同日期的合并到现有 group，其他新建
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      tmp.querySelectorAll(".g-group").forEach((g) => {
        const date = g.dataset.date;
        const exist = board.querySelector(`.g-group[data-date="${date}"]`);
        if (exist) {
          // 把新卡片追加到现有 inner，更新计数
          const inner = exist.querySelector(".g-board-inner");
          const newCards = g.querySelector(".g-board-inner").innerHTML;
          inner.insertAdjacentHTML("beforeend", newCards);
          const cnt = exist.querySelector(".g-group-count");
          if (cnt) cnt.textContent = `${inner.querySelectorAll(".g-card").length} 张`;
          bindGuestDeletes(inner);
        } else {
          // 新日期：插到尾部（但要避开"加载更多"占位；前面已 remove）
          board.appendChild(g);
          bindGuestDeletes(g);
        }
      });
    } else {
      board.innerHTML = html;
      bindGuestDeletes(board);
    }
    // "加载更多" 按钮
    if (guestHasMore) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "g-load-more";
      btn.innerHTML = "📜 加载更早的便签";
      btn.addEventListener("click", loadMoreGuestbook);
      board.appendChild(btn);
    }
  }

  // 优化 #6：分页加载更多（按游标）
  async function loadMoreGuestbook() {
    if (!guestNextCursor || !guestHasMore) return;
    const board = $("guestbookBoard");
    const btn = board && board.querySelector(".g-load-more");
    if (btn) { btn.disabled = true; btn.textContent = "加载中…"; }
    try {
      const u = new URL("/api/guestbook", location.origin);
      u.searchParams.set("limit", "50");
      u.searchParams.set("before", guestNextCursor.before);
      u.searchParams.set("before_id", String(guestNextCursor.before_id));
      const res = await fetch(u.pathname + u.search, { credentials: "same-origin", cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || res.status);
      guestNextCursor = data.nextCursor || null;
      guestHasMore = !!data.hasMore;
      renderGuestbook(data.notes || [], { append: true });
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = "📜 加载更早的便签"; }
      alert("加载失败：" + (e.message || "网络错误"));
    }
  }

  function bindGuestDeletes(board) {
    if (!guestbookCanDelete) return;
    board.querySelectorAll(".g-del").forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", async () => {
        const card = btn.closest(".g-card");
        const id = Number(btn.dataset.del);
        if (!id || !confirm("确定删除这张便签吗？")) return;
        try {
          const res = await fetch("/api/guestbook/manage", {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
          });
          const data = await res.json();
          if (data.ok) {
            if (card) card.remove();
            // 如果删除的是本机"我的便签"，从本地记忆移除
            if (guestbookMineIds.has(id)) removeMineId(id);
          }
          else alert(data.error || "删除失败");
        } catch (_) { alert("网络错误"); }
      });
    });
  }

  function renderTurnstile() {
    const container = $("turnstileWidget");
    if (!container) return;
    if (!turnstileSiteKey) { container.hidden = true; return; }
    if (typeof window.turnstile === "undefined") {
      // Turnstile 脚本还在加载，等脚本就绪事件自动触发
      return;
    }
    if (turnstileWidgetId) {
      window.turnstile.reset(turnstileWidgetId);
      return;
    }
    try {
      turnstileWidgetId = window.turnstile.render(container, {
        sitekey: turnstileSiteKey,
        theme: "auto",
        language: "zh-cn",
        callback: () => {
          const msg = $("guestbookMsg");
          if (msg) { msg.hidden = true; msg.textContent = ""; }
        },
      });
    } catch (e) {
      console.error("Turnstile render failed", e);
    }
  }

  // 注册表单的 Turnstile widget（与留言墙共用同一个 Site Key）
  function renderRegisterTurnstile() {
    const container = $("registerTurnstile");
    if (!container) return;
    if (!turnstileSiteKey) { container.hidden = true; return; }
    if (typeof window.turnstile === "undefined") return;
    if (registerWidgetId) {
      try { window.turnstile.reset(registerWidgetId); } catch (_) {}
      return;
    }
    try {
      registerWidgetId = window.turnstile.render(container, {
        sitekey: turnstileSiteKey,
        theme: "auto",
        language: "zh-cn",
        callback: () => { if (registerMsg) { registerMsg.textContent = ""; registerMsg.className = "form-msg"; } },
      });
    } catch (e) {
      console.error("Turnstile render failed (register)", e);
    }
  }

  // 拉取公开配置（仅 Turnstile Site Key，非密钥），成功后渲染各处 widget
  async function loadTurnstileConfig() {
    try {
      const res = await fetch("/api/config", { credentials: "same-origin", cache: "no-store" });
      const d = await res.json();
      if (d && d.turnstileSiteKey) turnstileSiteKey = d.turnstileSiteKey;
    } catch (_) { /* 配置拉取失败不阻塞页面 */ }
    renderTurnstile();
    renderRegisterTurnstile();
  }

  async function loadGuestbook() {
    if (guestbookLoaded) return;
    loadMineIds();
    const sk = $("guestbookSkeleton");
    if (sk) sk.innerHTML = '<div class="sk-card g-sk"></div>'.repeat(6);
    try {
      const res = await fetch("/api/guestbook", { credentials: "same-origin", cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || res.status);
      guestbookCanDelete = !!data.canDelete;
      turnstileSiteKey = data.turnstileSiteKey || null;
      guestNextCursor = data.nextCursor || null;
      guestHasMore = !!data.hasMore;
      renderGuestbook(data.notes || []);
      renderGuestStats(data.total, data.streak);
      renderTurnstile();
      guestbookLoaded = true;
    } catch (e) {
      const board = $("guestbookBoard");
      if (board) board.innerHTML = `<p style="color:var(--text-faint)">留言墙加载失败：${escapeHtml(e.message || "网络错误")}</p>`;
    }
  }

  function bindGuestbookForm() {
    const form = $("guestbookForm");
    if (!form || form.dataset.bound) return;
    form.dataset.bound = "1";
    const content = $("guestContent");
    const counter = $("guestbookCount");
    const submitBtn = $("guestSubmit");
    const msg = $("guestbookMsg");
    updateGuestbookAuthHint(); // 初始化时按当前登录态显示/隐藏名字栏

    if (content && counter) {
      content.addEventListener("input", () => { counter.textContent = `${content.value.length} / 200`; });
    }
    // 优化 #8：emoji 快捷插入
    const emojiBar = $("guestbookEmoji");
    function insertAtCursor(text) {
      if (!content) return;
      content.focus();
      const max = content.maxLength > 0 ? content.maxLength : 200;
      const start = content.selectionStart || 0;
      const end = content.selectionEnd || 0;
      const before = content.value.slice(0, start);
      const after = content.value.slice(end);
      const merged = (before + text + after);
      content.value = merged.slice(0, max);
      const pos = Math.min(start + text.length, content.value.length);
      content.setSelectionRange(pos, pos);
      content.dispatchEvent(new Event("input"));
    }
    if (emojiBar) {
      emojiBar.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-emoji]");
        if (!b) return;
        e.preventDefault();
        insertAtCursor(b.dataset.emoji || "");
      });
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = (content && content.value || "").trim();
      if (!text) {
        if (msg) { msg.hidden = false; msg.textContent = "便签内容不能为空"; msg.className = "guestbook-msg err"; }
        return;
      }
      // 提交前先记下「今天是否已有便签」，用于决定连续天数是否 +1
      const hadToday = !!document.querySelector(`.g-group[data-date="${gbTodayStr(0)}"]`);
      // 已登录时用登录名；未登录才回退到输入框
      const name = (currentUser && currentUser.username ? currentUser.username : ((($("guestName") || {}).value || "").trim()));
      if (msg) { msg.hidden = false; msg.textContent = "钉上中…"; msg.className = "guestbook-msg"; }
      if (submitBtn) submitBtn.disabled = true;
      const tsToken = (turnstileSiteKey && typeof window.turnstile !== "undefined") ? window.turnstile.getResponse(turnstileWidgetId) : null;
      if (turnstileSiteKey && !tsToken) {
        if (msg) { msg.hidden = false; msg.textContent = "请先完成人机验证"; msg.className = "guestbook-msg err"; }
        if (submitBtn) submitBtn.disabled = false;
        return;
      }
      try {
        const res = await fetch("/api/guestbook", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, content: text, turnstileToken: tsToken }),
        });
        const data = await res.json();
        if (data.ok && data.note) {
          // 标记为「我的便签」，渲染徽章
          addMineId(data.note.id);
          // 立即把新便签插到「今天」这一组最前面（无需刷新）
          const board = $("guestbookBoard");
          if (board) {
            const placeholder = board.querySelector("p");
            if (placeholder) placeholder.remove();
            const d = (data.note.created_at || "").slice(0, 10);
            let group = board.querySelector(`.g-group[data-date="${d}"]`);
            if (!group) {
              // 今天还没有分组 → 新建一个放到最前面
              group = document.createElement("div");
              group.className = "g-group";
              group.dataset.date = d;
              group.innerHTML = `<div class="g-group-head"><span class="g-group-label">今天</span><span class="g-group-count">0 张</span></div><div class="g-board-inner"></div>`;
              board.insertBefore(group, board.firstChild);
            }
            const inner = group.querySelector(".g-board-inner");
            if (inner) {
              inner.insertAdjacentHTML("afterbegin", buildGuestCard(data.note));
              const cnt = group.querySelector(".g-group-count");
              if (cnt) cnt.textContent = `${inner.querySelectorAll(".g-card").length} 张`;
              bindGuestDeletes(inner);
            }
          }
          // 乐观更新统计：总数 +1；若今天原本没有便签，连续天数 +1
          const tEl = $("gbTotal");
          if (tEl) tEl.textContent = String((Number(tEl.textContent) || 0) + 1);
          if (!hadToday) {
            const sEl = $("gbStreak");
            if (sEl) sEl.textContent = String((Number(sEl.textContent) || 0) + 1);
          }
          if (content) content.value = "";
          const nameInput = $("guestName"); if (nameInput) nameInput.value = "";
          if (counter) counter.textContent = "0 / 200";
          if (msg) { msg.textContent = "✅ 已钉上"; msg.className = "guestbook-msg ok"; }
          if (turnstileSiteKey && typeof window.turnstile !== "undefined") {
            try { window.turnstile.reset(turnstileWidgetId); } catch (_) {}
          }
        } else {
          if (msg) { msg.textContent = data.error || "提交失败"; msg.className = "guestbook-msg err"; }
          if (turnstileSiteKey && typeof window.turnstile !== "undefined") {
            try { window.turnstile.reset(turnstileWidgetId); } catch (_) {}
          }
        }
      } catch (_) {
        if (msg) { msg.textContent = "网络错误"; msg.className = "guestbook-msg err"; }
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  // ===== 深色模式 =====
  function applyTheme(mode) {
    document.documentElement.setAttribute("data-theme", mode);
    try { localStorage.setItem("blog-theme", mode); } catch (_) {}
    document.querySelectorAll(".theme-toggle").forEach((b) => { b.textContent = mode === "dark" ? "☀️" : "🌙"; });
  }
  // ② 主题切换：从按钮位置圆形扩散铺满再换色
  function themeBg(mode) {
    const probe = document.createElement("div");
    probe.setAttribute("data-theme", mode);
    probe.style.cssText = "position:fixed;inset:0;pointer-events:none;visibility:hidden;";
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).getPropertyValue("--bg").trim() || "#F5EFE6";
    probe.remove();
    return c;
  }
  function toggleTheme(e) {
    const cur = document.documentElement.getAttribute("data-theme") || "light";
    const next = cur === "dark" ? "light" : "dark";
    const btn = (e && e.currentTarget) || document.querySelector(".theme-toggle");
    const rect = btn ? btn.getBoundingClientRect() : { left: innerWidth - 30, top: 30, width: 0, height: 0 };
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:fixed;inset:0;z-index:9999;background:${themeBg(next)};clip-path:circle(0px at ${x}px ${y}px);transition:clip-path .5s ease;`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => { overlay.style.clipPath = `circle(${end}px at ${x}px ${y}px)`; });
    setTimeout(() => applyTheme(next), 250);
    setTimeout(() => overlay.remove(), 560);
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
    const el = $("lunarClock");
    const now = new Date();
    const shichenIdx = Math.floor(((now.getHours() + 1) % 24) / 2);
    const shichen = DI_ZHI[shichenIdx];
    if (typeof Lunar === "undefined") {
      if (el) el.textContent = "农历组件加载中…";
      return;
    }
    const lunar = Lunar.fromDate(now);
    const gz = lunar.getYearInGanZhi();
    const shengxiao = lunar.getYearShengXiao();
    const month = lunar.getMonthInChinese();
    const day = lunar.getDayInChinese();
    const pad = (n) => String(n).padStart(2, "0");
    if (el) {
      el.innerHTML = `🗓 ${gz}年（${shengxiao}）${month}月${day} · <strong>${shichen}时</strong> <span class="lunar-time">${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}</span>`;
      el.title = `农历时辰：${shichen}时（${SHICHEN_RANGE[shichenIdx]}）`;
    }
    // 侧边栏农历挂件：月份 + 日期条 + 24节气
    const gzEl = $("lunarGanZhi");
    const monthEl = $("lunarMonth");
    const jqEl = $("lunarJieQi");
    const daysEl = $("lunarDays");
    const scEl = $("lunarShiChen");
    if (gzEl) gzEl.textContent = `${gz}年 · ${shengxiao}`;
    if (monthEl) monthEl.textContent = `农历 ${month}月 · ${day}`;
    if (scEl) scEl.textContent = `${shichen}时（${SHICHEN_RANGE[shichenIdx]}）`;

    // 24节气：今日节气 or 下一个节气倒计时
    if (jqEl) {
      const current = lunar.getCurrentJieQi();
      if (current) {
        jqEl.textContent = `今日节气 · ${current.getName()}`;
      } else {
        try {
          const next = lunar.getNextJieQi(true);
          if (next && next.getSolar) {
            const s = next.getSolar();
            const today = Solar.fromYmd(now.getFullYear(), now.getMonth() + 1, now.getDate());
            const diff = Math.round((new Date(s.getYear(), s.getMonth() - 1, s.getDay()).getTime() - new Date(today.getYear(), today.getMonth() - 1, today.getDay()).getTime()) / 86400000);
            if (diff === 1) jqEl.textContent = `明日节气 · ${next.getName()}`;
            else jqEl.textContent = `${diff} 天后 · ${next.getName()}`;
          } else { jqEl.textContent = ""; }
        } catch (_) { jqEl.textContent = ""; }
      }
    }

    // 当月农历月历格子（像日历那样显示整月）
    if (daysEl) {
      try {
        const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
        const lunarYear = lunar.getYear();
        const lunarMonth = lunar.getMonth();
        const lunarDay = lunar.getDay();
        const month = LunarMonth.fromYm(lunarYear, lunarMonth);
        const dayCount = month.getDayCount();
        const firstLunar = Lunar.fromYmd(lunarYear, lunarMonth, 1);
        const firstSolar = firstLunar.getSolar();
        const startWeek = firstSolar.getWeek(); // 0=周日
        const todayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

        let html = weekdays.map((w) => `<div class="lunar-cal-head">${w}</div>`).join("");
        // 前置空白
        for (let i = 0; i < startWeek; i++) html += `<div class="lunar-cal-cell empty"></div>`;
        // 日期格子
        for (let d = 1; d <= dayCount; d++) {
          const ld = Lunar.fromYmd(lunarYear, lunarMonth, d);
          const sd = ld.getSolar();
          const solarYmd = `${sd.getYear()}-${sd.getMonth()}-${sd.getDay()}`;
          const isToday = solarYmd === todayKey;
          const lunarName = ld.getDayInChinese();
          html += `<div class="lunar-cal-cell ${isToday ? "today" : ""}"><span class="cal-solar">${sd.getDay()}</span><span class="cal-lunar">${lunarName}</span></div>`;
        }
        // 补齐最后一行
        const totalCells = startWeek + dayCount;
        const tail = (7 - (totalCells % 7)) % 7;
        for (let i = 0; i < tail; i++) html += `<div class="lunar-cal-cell empty"></div>`;
        daysEl.innerHTML = `<div class="lunar-calendar">${html}</div>`;
      } catch (_) { daysEl.textContent = "—"; }
    }
  }

  function updateSideClock() {
    const el = $("sideClock"); if (!el) return;
    const now = new Date();
    const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
    const dateEl = $("clockDate");
    if (dateEl) dateEl.textContent = `${now.getMonth() + 1}/${now.getDate()} ${wd}`;
    const hourHand = $("clockHour");
    const minHand = $("clockMin");
    const secHand = $("clockSec");
    if (!hourHand || !minHand || !secHand) return;
    const sec = now.getSeconds() + now.getMilliseconds() / 1000;
    const min = now.getMinutes() + sec / 60;
    const hour = (now.getHours() % 12) + min / 60;
    // 秒针改纯 CSS 动画（secSpin 60s 连续扫秒），仅初始化相位一次
    if (!secHand.dataset.cssSpin) {
      secHand.style.animationDelay = `${-sec}s`;
      secHand.dataset.cssSpin = "1";
    }
    minHand.style.transform = `rotate(${min * 6}deg)`;
    hourHand.style.transform = `rotate(${hour * 30}deg)`;
  }
  updateSideClock();
  setInterval(() => { updateLunar(); updateSideClock(); }, 1000);

  // ===== 全局交互 =====
  const topbarEl = $("topbar");
  window.addEventListener("scroll", () => {
    if (backTop) backTop.classList.toggle("show", window.scrollY > 400);
    if (topbarEl) topbarEl.classList.toggle("scrolled", window.scrollY > 20);
  });
  if (backTop) backTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

  // ===== 图片灯箱 =====
  const lightbox = $("lightbox");
  const lightboxImg = $("lightboxImg");
  const lightboxClose = $("lightboxClose");
  function openLightbox(src, alt) {
    if (!lightbox || !lightboxImg) return;
    lightboxImg.src = src; lightboxImg.alt = alt || "";
    lightbox.hidden = false; document.body.classList.add("lightbox-open");
  }
  function closeLightbox() {
    if (!lightbox) return;
    lightbox.hidden = true; lightboxImg.removeAttribute("src"); document.body.classList.remove("lightbox-open");
  }
  if (postDetail) postDetail.addEventListener("click", (e) => {
    const img = e.target.closest(".post-body img");
    if (img) { e.preventDefault(); openLightbox(img.currentSrc || img.src, img.alt); }
  });
  if (lightbox) lightbox.addEventListener("click", (e) => { if (e.target === lightbox || e.target === lightboxClose) closeLightbox(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && lightbox && !lightbox.hidden) closeLightbox(); });
  if (sliderEl) {
    sliderEl.addEventListener("mouseenter", () => { hoverPaused = true; stopAuto(); });
    sliderEl.addEventListener("mouseleave", () => { hoverPaused = false; startAuto(); });
    // 滚出视口暂停自动播放，回到视口恢复（省电 + 不打扰阅读）
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting && !hoverPaused) startAuto();
          else stopAuto();
        });
      }, { threshold: 0.15 });
      io.observe(sliderEl);
    } else {
      startAuto();
    }
  }
  if (slidePrev) slidePrev.addEventListener("click", () => goSlide(currentSlide - 1));
  if (slideNext) slideNext.addEventListener("click", () => goSlide(currentSlide + 1));
  if (themeToggle) themeToggle.addEventListener("click", toggleTheme);
  const themeToggleTop = $("themeToggleTop");
  if (themeToggleTop) themeToggleTop.addEventListener("click", toggleTheme);
  const hamburgerTop = $("hamburgerTop");
  if (hamburgerTop) hamburgerTop.addEventListener("click", toggleSidebar);

  // 搜索防抖 + Enter 触发 + 错误提示
  let searchTimer = null;
  async function doSearch(q) {
    searchQuery = q;
    if (!q) { renderCards(); return; }
    if (cardGrid) cardGrid.innerHTML = '<p style="color:var(--text-faint);grid-column:1/-1;">正在搜索…</p>';
    try {
      const res = await fetch(`/api/posts/search?q=${encodeURIComponent(q)}`, { credentials: "same-origin", cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        console.error("搜索接口异常:", res.status, data);
        if (cardGrid) cardGrid.innerHTML = `<p style="color:var(--text-soft);grid-column:1/-1;">搜索失败：${escapeHtml(data.error || `HTTP ${res.status}`)}</p>`;
        return;
      }
      renderCardsFrom(data.posts || []);
    } catch (err) {
      console.error("搜索请求失败:", err);
      if (cardGrid) cardGrid.innerHTML = '<p style="color:var(--text-soft);grid-column:1/-1;">搜索请求失败，请检查网络或刷新后重试。</p>';
    }
  }
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => doSearch(searchInput.value.trim()), 250);
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { clearTimeout(searchTimer); doSearch(searchInput.value.trim()); }
    });
  }

  // 导航
  navLinks.forEach((link) => link.addEventListener("click", (e) => { e.preventDefault(); showView(link.dataset.view); window.scrollTo({ top: 0, behavior: "smooth" }); }));
  if (backBtn) backBtn.addEventListener("click", () => showView("home"));
  bindGuestbookForm();
  loadTurnstileConfig();
  if (window.turnstile && window.turnstile.ready) {
    window.turnstile.ready(() => { renderTurnstile(); renderRegisterTurnstile(); });
  }
  if (composeBack) composeBack.addEventListener("click", () => { editingSlug = ""; if (composeSubmit) composeSubmit.textContent = "发布文章"; showView("home"); });

  // ===== 会员会话 =====
  // currentUser 已在 IIFE 顶部声明（避免 TDZ），此处不再重复声明
  let currentPostAuthor = "";    // 当前打开文章的作者
  let currentSlug = "";          // 当前打开文章的 slug
  let currentPost = null;        // 当前打开文章的完整数据（用于编辑）
  let editingSlug = "";          // 非空表示正在编辑该 slug 的文章
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
    if (typeof updateGuestbookAuthHint === "function") updateGuestbookAuthHint();
  }
  async function checkSession() { try { const r = await fetch("/api/me", { credentials: "same-origin", cache: "no-store" }); const d = await r.json(); currentUser = d.user; setAuthUI(d.user); return d.user; } catch (_) { currentUser = null; setAuthUI(null); return null; } }
  function openAuth(tab) { if (!authModal) return; authModal.hidden = false; switchTab(tab || "login"); if (typeof startCharInteraction === "function") startCharInteraction(); }
  function closeAuth() { if (authModal) authModal.hidden = true; if (loginMsg) loginMsg.textContent = ""; if (registerMsg) registerMsg.textContent = ""; if (typeof stopCharInteraction === "function") stopCharInteraction(); setAuthState("idle"); }
  function switchTab(tab) { document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab)); loginForm.classList.toggle("active", tab === "login"); registerForm.classList.toggle("active", tab === "register"); if (typeof switchQuote === "function") switchQuote(tab); if (tab === "register" && typeof renderRegisterTurnstile === "function") renderRegisterTurnstile(); }

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
    const tsToken = (turnstileSiteKey && typeof window.turnstile !== "undefined") ? window.turnstile.getResponse(registerWidgetId) : null;
    if (turnstileSiteKey && !tsToken) {
      registerMsg.textContent = "请先完成人机验证"; registerMsg.className = "form-msg err";
      triggerState("error", 2500);
      return;
    }
    try {
      const r = await fetch("/api/register", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: fd.get("username"), email: fd.get("email"), password: fd.get("password"), turnstileToken: tsToken }) });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        registerMsg.textContent = d.error || "注册失败"; registerMsg.className = "form-msg err";
        triggerState("error", 2500);
        if (turnstileSiteKey && typeof window.turnstile !== "undefined") {
          try { window.turnstile.reset(registerWidgetId); } catch (_) {}
        }
        return;
      }
      if (turnstileSiteKey && typeof window.turnstile !== "undefined") {
        try { window.turnstile.reset(registerWidgetId); } catch (_) {}
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
  function openCompose(post) {
    showView("compose");
    if (post && post.slug) {
      editingSlug = post.slug;
      if (composeTitle) composeTitle.value = post.title || "";
      if (composeTag) composeTag.value = post.tag || "";
      if (composeSummary) composeSummary.value = post.summary || "";
      if (composeCover) composeCover.value = post.cover || "";
      if (composeBody) composeBody.value = post.body || "";
      if (composeSubmit) composeSubmit.textContent = "保存修改";
    } else {
      editingSlug = "";
      if (composeTitle) composeTitle.value = "";
      if (composeTag) composeTag.value = "";
      if (composeSummary) composeSummary.value = "";
      if (composeCover) composeCover.value = "";
      if (composeBody) composeBody.value = "";
      if (composeSubmit) composeSubmit.textContent = "发布文章";
    }
    if (composePreview) composePreview.innerHTML = mdToHtml((post && post.body) || "") || "<p style='color:var(--text-faint)'>实时预览…</p>";
    if (composeMsg) composeMsg.textContent = "";
  }

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
  // 上传按钮现在是 <label for="composeFile">，靠原生 label 行为触发文件选择器，
  // 避免移动端对隐藏 file input 的 programmatic click 支持不稳定的问题。
  const composeFileInput = $("composeFile");
  if (composeFileInput) {
    composeFileInput.addEventListener("change", async () => {
      const ta = composeBody; if (!ta) return;
      const files = Array.from(composeFileInput.files || []);
      composeFileInput.value = "";
      if (!files.length) return;
      if (composeMsg) { composeMsg.textContent = `正在压缩 1/${files.length} 张图片…`; composeMsg.className = "form-msg"; }
      let inserted = 0;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.type.startsWith("image/")) { if (composeMsg) composeMsg.textContent = `已跳过非图片文件：${file.name}`; continue; }
        if (composeMsg) composeMsg.textContent = `正在压缩 ${i + 1}/${files.length}：${file.name}`;
        try {
          const dataUrl = await compressImage(file, 960, 0.72);
          const name = (file.name || "image").replace(/\.[^.]+$/, "");
          insertAtCursor(ta, `\n![${name}](${dataUrl})\n`);
          inserted++;
        } catch (e) {
          if (composeMsg) { composeMsg.textContent = `「${file.name}」处理失败，可能文件过大`; composeMsg.className = "form-msg err"; }
        }
      }
      ta.focus();
      ta.dispatchEvent(new Event("input"));
      if (inserted && composeMsg) { composeMsg.textContent = `✅ 已插入 ${inserted}/${files.length} 张图片（已压缩存入正文）`; composeMsg.className = "form-msg ok"; }
    });
  }

  // 压缩图片：缩放到 maxW 宽、quality 质量的 JPEG，返回 data: URL。
  // 若结果仍超过单图上限，自动降低质量二次压缩，避免 4 张图把正文撑得太大、加载慢。
  async function compressImage(file, maxW = 960, quality = 0.72) {
    const MAX_BYTES = 320 * 1024; // 单图约 320KB，4 张图合计约 1.2MB 左右
    let dataUrl = await compressOnce(file, maxW, quality);
    // 估算 base64 字节数（data: 头约占 23 字节，base64 每字符 0.75 字节）
    let bytes = estimateBase64Bytes(dataUrl);
    if (bytes <= MAX_BYTES) return dataUrl;

    if (composeMsg) composeMsg.textContent = `图片较大，正在二次压缩…`;
    dataUrl = await compressOnce(file, Math.min(maxW, 800), 0.60);
    bytes = estimateBase64Bytes(dataUrl);
    if (bytes <= MAX_BYTES) return dataUrl;

    dataUrl = await compressOnce(file, Math.min(maxW, 720), 0.50);
    return dataUrl;
  }

  function estimateBase64Bytes(dataUrl) {
    const idx = dataUrl.indexOf(",");
    const base64 = idx > -1 ? dataUrl.slice(idx + 1) : dataUrl;
    return Math.ceil(base64.length * 0.75);
  }

  function compressOnce(file, maxW, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxW) { height = Math.round(height * maxW / width); width = maxW; }
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#FFFFFF";
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
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
    if (composeMsg) { composeMsg.textContent = editingSlug ? "保存中…" : "发布中…"; composeMsg.className = "form-msg"; }
    if (composeSubmit) composeSubmit.disabled = true;
    try {
      let res, data;
      const payload = { title, tag: (composeTag?.value || "").trim(), summary: (composeSummary?.value || "").trim(), cover: (composeCover?.value || "").trim(), body };
      if (editingSlug) {
        res = await fetch("/api/posts/manage", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "update", slug: editingSlug, ...payload }) });
      } else {
        res = await fetch("/api/posts", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      }
      data = await res.json();
      if (!res.ok || !data.ok) { if (composeMsg) { composeMsg.textContent = data.error || (editingSlug ? "保存失败" : "发布失败"); composeMsg.className = "form-msg err"; } return; }
      postCache.delete(editingSlug); // 文章有变动，失效详情缓存
      if (composeMsg) { composeMsg.innerHTML = editingSlug ? "✅ 已保存" : "✅ 已发布"; composeMsg.className = "form-msg ok"; }
      const slugToOpen = editingSlug || data.slug;
      editingSlug = "";
      if (composeSubmit) composeSubmit.textContent = "发布文章";
      setTimeout(() => { if (slugToOpen) openPost(slugToOpen); else { showView("home"); loadPosts(); } }, 800);
    } catch (_) { if (composeMsg) { composeMsg.textContent = "网络错误"; composeMsg.className = "form-msg err"; } } finally { if (composeSubmit) composeSubmit.disabled = false; }
  }

  async function handleDeletePost(slug) {
    if (!slug) return;
    if (!confirm("确定删除这篇文章吗？删除后无法恢复。")) return;
    try {
      const res = await fetch("/api/posts/manage", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", slug }) });
      const data = await res.json();
      if (!res.ok || !data.ok) { alert(data.error || "删除失败"); return; }
      postCache.delete(slug); // 失效详情缓存
      showView("home"); loadPosts();
    } catch (_) { alert("网络错误，删除失败"); }
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

  // 农历库体积较大(~436KB)，用 setTimeout 异步加载避免阻塞首屏；
  // updateLunar 已内置 typeof Lunar 保护，库加载完成前 widget 显示占位，加载后自动生效
  (function loadLunarLib() {
    var done = false;
    function inject() {
      if (done) return; done = true;
      var s = document.createElement("script");
      s.src = "assets/vendor/lunar.js";
      s.async = true;
      s.onload = function () { try { updateLunar(); updateSideClock(); } catch (e) {} };
      s.onerror = function () { done = false; };
      document.head.appendChild(s);
    }
    setTimeout(inject, 0);
  })();
  // 兜底：若 5s 后农历库仍未加载（极端跨境抖动），把挂件从「加载中」降级为「—」，不再永久卡住
  setTimeout(() => {
    if (typeof Lunar === "undefined") {
      const el = document.getElementById("lunarClock");
      if (el && /加载中/.test(el.textContent)) el.textContent = "—";
    }
  }, 5000);
  bindInputStates();
  checkSession();
  loadPosts();

  // 若 URL 带 ?post=slug，自动打开对应文章（分享链接可用）
  const startParams = new URLSearchParams(location.search);
  const startSlug = startParams.get("post");
  if (startSlug) {
    setTimeout(() => openPost(decodeURIComponent(startSlug)), 300);
  }

})();