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
  // ── 规范化站点路径：同样取 canonical 的 pathname，而不是 location.pathname ──
  // 从 /index.html?post=x 这类别名路径进来时，location.pathname 会把这个丑路径一起分享出去。
  const SITE_PATH = (() => {
    const c = document.querySelector('link[rel="canonical"]');
    try { return c ? new URL(c.href).pathname : "/"; } catch { return "/"; }
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
  // 编辑器封面是否被用户改动过：没动过就不提交 cover 字段，后端保持 D1 原值。
  // （快照里的 cover 是构建产物路径，预填后原样提交会把原始图片永久覆盖掉）
  let composeCoverDirty = false;

  // ── 搜索 ──
  const searchInput = $("searchInput");

  // ── 深色模式 ──
  const themeToggle = $("themeToggle");

  // ── 移动端 ──
  const hamburger = $("hamburger");
  const hamburgerTop = $("hamburgerTop");
  const sidebar = $("sidebar");
  const sidebarOverlay = $("sidebarOverlay");
  const mainNav = $("mainNav");

  // ── 状态 ──
  let posts = [];
  let activeTag = "全部";
  let currentSlide = 0, totalSlides = 0, slideTimer = null, hoverPaused = false;
  let searchQuery = "";
  let tocScrollHandler = null;
  // ⚠️ 以下状态变量必须全部声明在 IIFE 顶部。
  // 原因：openPost()（约 435 行）等**函数体内的赋值**会写这些变量，而它们若在文件后半段
  // 才用 let 声明，函数一旦被调用就落在暂时性死区（TDZ）里 → ReferenceError。
  // 更隐蔽的是 openPost 外层有 `catch(_)`，异常被静默吞掉，用户只看到「文章加载失败」，
  // 控制台一片安静。历史上只修了 currentUser，其余 6 个漏了，导致打开任何文章都失败。
  // 排查方法：node scripts/verify-no-tdz.mjs（已纳入全量回归）。
  let currentUser = null;
  let sessionReady = false;       // 会话已校验过则不再每次打开文章都请求 /api/me
  let sessionPromise = null;      // 进行中的会话校验：启动与「打开文章」共用同一个请求（去重）
  let currentPostAuthor = "";     // 当前打开文章的作者
  let currentSlug = "";           // 当前打开文章的 slug
  let currentPost = null;         // 当前打开文章的完整数据（用于编辑）
  let editingSlug = "";           // 非空表示正在编辑该 slug 的文章
  let commentSort = "new";        // 评论排序：new 最新 / hot 最热
  let replyTo = 0;                // 正在回复的父评论 id（0 = 顶层新评）
  let openSeq = 0;                // openPost 请求序号：用于丢弃过期响应（快速切文章防串内容）
  let progressHandler = null;     // 阅读进度 scroll 监听：每次打开文章前先移除旧的，避免叠加
  const postCache = new Map();    // 文章详情客户端缓存：slug -> post，避免重复打开重复拉取大体积正文

  // ===== Markdown → HTML =====
  // URL 协议白名单：默认只放行 http/https/mailto/tel，以及站内相对路径（/、#、./、?、纯相对）。
  // 图片额外允许 data:image 位图（站内后台上传就是 base64）。其余（javascript:、vbscript:、
  // data:text/html、data:image/svg+xml 等）一律返回空串，由调用方降级为纯文本。
  // 注意：调用方传入的已经是 HTML 转义后的字符串，这里只做协议判定，不做转义。
  function safeUrl(raw, allowDataImage) {
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

  // 构建产物路径（/generated/...）：快照与 og:image 解析都会产出这类 URL，但它不是用户的原始封面。
  // 它不入版本库、每次构建都可能改名 —— 若被当成封面写回数据库，D1 里的原始 data: 图片会被覆盖，
  // 原图就永久丢失了（2026-09 真实事故）。编辑器与提交逻辑都要绕开它。
  function isArtifactCover(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return false;
    if (s.startsWith("/generated/")) return true;
    if (!/^https?:\/\//i.test(s)) return false;
    try { return new URL(s).pathname.startsWith("/generated/"); } catch (_) { return false; }
  }

  function mdToHtml(md) {
    // 转义 & < > " '：正文由任何注册用户撰写，必须转义引号否则可闭合属性注入事件处理器
    const esc = (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
      // 正文标题从 h2 起步：h1 归文章标题所有（一页只能有一个 h1），所以 "# " 与 "## " 都落 h2，"### " 落 h3。
      // 与 scripts/lib/seo-render.mjs 的 renderMarkdown() 必须逐条一致（verify-seo-render 会比对两边输出）。
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
  // 无封面卡片固定奶油玻璃底色（与标题无关，杜绝绿/红等差异色）
  // 用 CSS 变量引用底色，跟随明暗主题；括号里的值是变量缺失时的兜底
  function glassBg() { return "linear-gradient(135deg, var(--slide-glass-1, hsl(38,42%,92%)), var(--slide-glass-2, hsl(33,38%,86%)))"; }
  function coverStyle(p) { return p.cover ? `background-image:url('${p.cover}');` : `background:${glassBg()};`; }

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
    // 用 cache:"default" 走 HTTP 缓存策略（_headers 里配的是 SWR：先命中本地缓存秒开，
    // 后台再验证）。⚠️ 不要改回 "force-cache"：那是「无条件用本地缓存、永不校验」——
    // 构建会更换封面文件名（命名规则变更 / 换图），旧快照会一直指向已删除的文件，
    // 表现就是「列表里的图全部不显示」，而且刷新也永远修不回来。
    // 304（本地缓存有效、响应体为空）也视为命中、安全回退动态接口，避免白屏。
    try {
      const sres = await fetchJSON("/generated/posts.json", { cache: "default", timeout: 8000 });
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
      <div class="slide ${i === 0 ? "active" : ""} ${p.cover ? "" : "no-cover"}" data-slug="${escapeHtml(p.slug)}" style="${coverStyle(p)}">
        <div class="slide-overlay"><span class="slide-tag">${escapeHtml(p.tag)}</span><h2 class="slide-title">${escapeHtml(p.title)}</h2><p class="slide-summary">${escapeHtml(p.summary || "")}</p><button class="slide-read" data-slug="${escapeHtml(p.slug)}">阅读全文 →</button></div>
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
    const hasCover = !!p.cover;
    const cls = [i === 0 ? "feature" : i === 1 ? "wide" : "", hasCover ? "" : "no-cover"].filter(Boolean).join(" ");
    const cover = hasCover
      ? `<div class="card-cover"><img class="card-cover-img" src="${escapeHtml(safeUrl(p.cover, true))}" loading="lazy" decoding="async" alt=""></div>`
      : "";
    return `
      <article class="card ${cls}" data-slug="${escapeHtml(p.slug)}">
        ${cover}
        <div class="card-body">
          <div class="card-meta"><span class="tag">${escapeHtml(p.tag)}</span><span>${formatDate(p.date)}</span><span>✍ ${escapeHtml(p.author)}</span></div>
          <h2>${escapeHtml(p.title)}</h2><p>${escapeHtml(p.summary || "")}</p>
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
    // 竞态保护：每次进入取一个自增序号，任何 await 之后若发现序号已变（用户又点了别的文章），
    // 立即放弃本次渲染，避免「后发先至」的旧响应覆盖新文章，出现标题与正文错配。
    const seq = ++openSeq;
    const stale = () => seq !== openSeq;
    const p = posts.find((x) => x.slug === slug);
    if (p) postDetail.innerHTML = `<div class="post-meta"><span class="tag">${p.tag}</span><span>${formatDate(p.date)}</span><span class="author">✍ ${p.author}</span></div><h1>${p.title}</h1><p style="color:var(--text-faint)">加载中…</p>`;
    showView("post"); window.scrollTo({ top: 0, behavior: "smooth" });
    try {
      // slug 放 body，避免部分国产浏览器（小米等）fetch 对中文 slug 的 % 编码损坏
      let post = postCache.get(slug);
      let fromStatic = false;
      if (!post) {
        // 静态预渲染优先：CDN 直读 /generated/posts/<slug>.json（含 body，秒回）；
        // 缺失/失败则降级到 Function 动态接口。
        // 同样用 cache:"default" 遵守 SWR：封面文件名会随构建变化，force-cache 会拿到旧路径。
        try {
          const sres = await fetchJSON(`/generated/posts/${encodeURIComponent(slug)}.json`, { cache: "default", timeout: 8000 });
          if (stale()) return;
          // 304 视为静态命中（无 body），回退下方动态接口；200 正常解析
          if (sres.ok || sres.status === 304) {
            if (sres.ok) {
              const sd = await sres.json();
              if (stale()) return;
              if (sd && sd.ok && sd.post) { post = sd.post; fromStatic = true; }
            }
          }
        } catch (_) {}
        if (stale()) return;
        if (!post) {
          const res = await fetch("/api/posts/detail", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) });
          const data = await res.json();
          if (stale()) return;
          if (!res.ok || !data.ok || !data.post) { postDetail.innerHTML = `<p style="color:var(--text-faint)">文章加载失败：${(data && data.error) || res.status}</p>`; return; }
          post = data.post;
        }
        postCache.set(slug, post);
      }
      if (stale()) return;
      updateMeta(post);
      // ── 关键路径到此为止，下面只做渲染 ──
      // 「会话」(/api/me) 与「阅读数 +1」(/api/posts/view) 都是**装饰性**信息，
      // 但两者都是 no-store（永远不走缓存），原先串行挡在渲染之前 →
      // 每次打开文章都白等两次跨境往返，与正文内容毫无关系。
      // 线上实测（暖缓存）：静态正文 563ms 就到了，正文却到 1171ms 才出现，
      // 其中约 600ms 全部花在这两次请求上。现在改为「先渲染、后补齐」。
      currentSlug = slug;
      currentPost = post;
      currentPostAuthor = post.author;
      const isAuthor = !!post.isAuthor;   // 可能来自 postCache 的上一次会话结果；随后由 patchPostMeta 校正
      const manageBtns = isAuthor ? postActionsHtml(slug) : "";
      const heroCover = post.cover ? safeUrl(post.cover, true) : "";
      const hero = heroCover ? `<img class="post-cover" src="${escapeHtml(heroCover)}" alt="">` : "";
      const toc = buildToc(post.body || "");
      const tocHtml = toc.length ? `<nav class="toc"><div class="toc-title">📑 目录</div><ul class="toc-list">${toc.map((t) => `<li class="toc-l${t.level}"><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`).join("")}</ul></nav>` : "";
      const shareUrl = postShareUrl(slug);
      const shareBtns = `<div class="post-share"><button class="share-btn" data-share="copy" data-url="${escapeHtml(shareUrl)}" type="button">📋 复制链接</button><button class="share-btn" data-share="open" data-slug="${escapeHtml(slug)}" type="button">📤 分享</button></div>`;
      // 文末入口：长文读到底想分享时，不必再滚回顶部（两个入口共用同一个面板）
      const shareBtnsEnd = `<div class="post-share post-share-end"><span class="share-end-label">觉得有用？</span><button class="share-btn" data-share="open" data-slug="${escapeHtml(slug)}" type="button">📤 分享给朋友</button><button class="share-btn" data-share="copy" data-url="${escapeHtml(shareUrl)}" type="button">📋 复制链接</button></div>`;
      const nav = buildPostNav(slug);
      postDetail.innerHTML = `<div class="post-meta"><span class="tag">${post.tag}</span><span>${formatDate(post.date)}</span><span class="author">✍ ${post.author}</span><span class="read-time"></span>${manageBtns}</div>${hero}<h1>${post.title}</h1>${shareBtns}${tocHtml}<div class="post-body">${mdToHtml(post.body || "")}</div>${nav}${shareBtnsEnd}<section class="comments" id="comments"><div class="comments-head"><h2 class="comments-title">💬 评论</h2><div class="comment-sort"><button class="sort-btn active" data-sort="new" type="button">最新</button><button class="sort-btn" data-sort="hot" type="button">最热</button></div></div><div class="comment-list" id="commentList"><p class="comments-loading">加载评论中…</p></div><div class="reply-hint" id="replyHint" hidden>回复 <b id="replyName"></b><button type="button" id="replyCancel" class="reply-cancel" title="取消回复">✕</button></div><form class="comment-form" id="commentForm"><textarea class="comment-input" id="commentInput" placeholder="说点什么…" maxlength="2000"></textarea><div class="comment-actions"><span class="comment-msg" id="commentMsg"></span><button class="btn-submit" type="submit">发表评论</button></div></form></section>`;
      renderReadTime(post);   // 与 patchPostMeta 共用同一处格式化，避免两份文案漂移
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
      // ── 渲染完成，正文已经可读。下面才去补装饰性信息（不 await，不阻塞）──
      patchPostMeta(slug, seq, fromStatic);
    } catch (e) {
      // 详细记日志、模糊给用户：不能像历史上那样把异常整个吞掉（见文件顶部的 TDZ 注释）
      console.error("[post] 打开文章失败", slug, e);
      postDetail.innerHTML = `<p style="color:var(--text-faint)">文章加载失败，请重试</p>`;
    }
  }

  // 阅读时长/字数/阅读数这一行的唯一格式化入口（初次渲染与「阅读数回来」都走它）
  function renderReadTime(post) {
    const el = postDetail.querySelector(".read-time");
    if (!el || !post) return;
    el.textContent = `⏱ 约 ${post.readingMinutes || 0} 分钟 · ${post.words || 0} 字 · ${post.views || 0} 阅读`;
  }

  function postActionsHtml(slug) {
    return `<span class="post-actions"><button class="post-edit" data-edit-slug="${escapeHtml(slug)}" type="button">✏️ 编辑</button><button class="post-del" data-del-slug="${escapeHtml(slug)}" type="button">🗑 删除</button></span>`;
  }

  // 正文渲染**之后**才做的两件装饰性小事：
  //   ① 会话 → 决定要不要显示「编辑 / 删除」（编辑/删除按钮是事件委托绑定的，后插也能用）
  //   ② 静态快照没经过 detail.js 的 +1，这里补一次实时阅读数
  // 两者原先都串行挡在渲染前，且都是 no-store（永不缓存）→ 每次打开文章平白多等约 600ms。
  // 现在允许它们慢、允许它们失败：正文已经看得见了，这里只负责把细节补上。
  // ⚠️ 每一处改 DOM 之前都要复查 stale()（用户可能已经切到别的文章了）。
  async function patchPostMeta(slug, seq, fromStatic) {
    const stale = () => seq !== openSeq || currentSlug !== slug;
    try {
      const user = await ensureSession();
      if (stale()) return;
      if (currentPost && currentPost.slug === slug) {
        currentPost.isAuthor = !!(user && user.username && currentPost.author &&
          (user.username === currentPost.author || user.isOwner));
      }
      const meta = postDetail.querySelector(".post-meta");
      if (!meta) return;
      const existing = meta.querySelector(".post-actions");
      const isAuthor = !!(currentPost && currentPost.isAuthor);
      if (isAuthor && !existing) meta.insertAdjacentHTML("beforeend", postActionsHtml(slug));
      else if (!isAuthor && existing) existing.remove();
    } catch (e) { console.error("[post] 会话补齐失败", slug, e); }

    if (!fromStatic) return; // 动态接口（detail.js）已经 +1 过，不要重复计数
    try {
      const vres = await fetch("/api/posts/view", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }),
      });
      const vd = await vres.json();
      if (stale()) return;
      if (vd && vd.ok && typeof vd.views === "number" && currentPost && currentPost.slug === slug) {
        currentPost.views = vd.views;
        renderReadTime(currentPost);
      }
    } catch (e) { console.error("[post] 阅读数更新失败", slug, e); }
  }

  // ===== 工具函数 =====
  // 统一转义 & < > " '：既用于文本内容，也用于属性值（含 style 里的 CSS url()）
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
  function readingTime(md) {
    const text = (md || "").replace(/!\[[^\]]*\]\([^)]+\)/g, "").replace(/[#*`\[\](){}|>\-]/g, "");
    const cjkChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const nonCjkWords = text.replace(/[\u4e00-\u9fa5]/g, " ").trim().split(/\s+/).filter((x) => x).length;
    const words = cjkChars + nonCjkWords;
    return { words, minutes: Math.max(1, Math.round(words / 300)) };
  }
  // ===== 分享 =====
  function postShareUrl(slug) { return SITE_ORIGIN + SITE_PATH + "?post=" + encodeURIComponent(slug); }

  // 轻提示：替代 alert —— 不阻塞、不抢焦点、不打断输入
  let toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    if (!el) { try { alert(msg); } catch (_) {} return; }   // HTML 缺容器时的极端兜底
    el.textContent = msg;                                   // textContent：天然防注入
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => { if (!el.classList.contains("show")) el.hidden = true; }, 240);
    }, 2200);
  }

  // 复制降级链：① 异步剪贴板 → ② execCommand（http / 老浏览器）→ ③ 提示手动复制。
  // 不能只看 navigator.clipboard 是否存在：非安全上下文里它存在但一定 reject（原来是 .catch(()=>{}) 静默吞掉）。
  function legacyCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch (_) { return false; }
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
  }
  function copyShareUrl(url, okMsg) {
    if (!url) return Promise.resolve(false);
    return copyText(url).then((ok) => {
      toast(ok ? (okMsg || "链接已复制，去粘贴吧") : "复制失败，请长按输入框手动复制");
      return ok;
    });
  }

  // ===== 分享面板 =====
  // 三个环境分支（重点：Web Share 在微信内置浏览器里不可用，桌面也未必有）：
  //   微信内 → 提示「点右上角 ··· 发送给朋友」，不显示二维码（在微信里扫自己的码没意义）
  //   支持 Web Share 的手机 → 首项「系统分享」，直接调起原生面板
  //   桌面 → 走「微信 → 二维码」，手机扫码在微信里打开
  const IN_WECHAT = /MicroMessenger/i.test(navigator.userAgent || "");
  let shareCtx = null, shareReturnFocus = null, qrLibLoading = null;

  // 二维码库按需懒加载（56KB）：只有真的要显示二维码才拉，首页与正常阅读都不加载
  function ensureQrLib() {
    if (window.qrcode) return Promise.resolve();
    if (qrLibLoading) return qrLibLoading;
    qrLibLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "assets/vendor/qrcode.js";
      s.onload = () => resolve();
      s.onerror = () => { qrLibLoading = null; reject(new Error("qrcode load failed")); };
      document.head.appendChild(s);
    });
    return qrLibLoading;
  }

  // 画二维码：固定「白底深码」不跟随主题 —— 深色主题下用主题色会拉低对比度导致扫不出来
  async function renderShareQr(url) {
    const canvas = $("shareQr"), wrap = $("shareQrWrap");
    if (!canvas || !wrap) return;
    try {
      await ensureQrLib();
      const qr = window.qrcode(0, "M");     // 版本 0 = 自动选择，M = 15% 纠错
      qr.addData(url);
      qr.make();
      const n = qr.getModuleCount();
      const quiet = 4;                      // 静区：扫码规范要求四周留 4 个模块
      const scale = Math.max(2, Math.floor(160 / (n + quiet * 2)));
      const px = (n + quiet * 2) * scale;
      canvas.width = px;
      canvas.height = px;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, px, px);
      ctx.fillStyle = "#1A1815";
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
        }
      }
      wrap.hidden = false;
    } catch (_) {
      wrap.hidden = true;
      toast("二维码加载失败，可先复制链接");
    }
  }

  function openShare(post) {
    const host = $("shareModal");
    if (!host || !post) return;
    const url = postShareUrl(post.slug);
    const summary = (post.summary || "").trim() ||
      (post.body || "").replace(/[#>*`\-!\[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, 78);
    shareCtx = { url, title: post.title || "", summary };
    const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    setText("shareTitle", post.title || "");
    setText("shareSum", summary);
    const link = $("shareLink");
    if (link) link.value = url;
    const thumb = $("shareThumb");
    const cover = post.cover ? safeUrl(post.cover, true) : "";
    if (thumb) {
      if (cover) { thumb.src = cover; thumb.hidden = false; }
      else { thumb.removeAttribute("src"); thumb.hidden = true; }
    }
    const sysBtn = host.querySelector('[data-channel="system"]');
    if (sysBtn) sysBtn.hidden = typeof navigator.share !== "function";
    const tip = $("shareTip");
    if (tip) {
      tip.hidden = !IN_WECHAT;
      if (IN_WECHAT) tip.textContent = "点右上角 ··· → 发送给朋友 / 分享到朋友圈";
    }
    const qrWrap = $("shareQrWrap");
    if (qrWrap) qrWrap.hidden = true;        // 每次打开先收起，避免残留上一篇的二维码
    host.hidden = false;
    document.body.style.overflow = "hidden";
    shareReturnFocus = document.activeElement;
    const closeBtn = $("shareClose");
    if (closeBtn) closeBtn.focus();
  }

  function closeShare() {
    const host = $("shareModal");
    if (!host || host.hidden) return;
    host.hidden = true;
    document.body.style.overflow = "";
    if (shareReturnFocus && typeof shareReturnFocus.focus === "function") { try { shareReturnFocus.focus(); } catch (_) {} }
    shareReturnFocus = null;
    shareCtx = null;
  }

  function bindSharePanel() {
    const host = $("shareModal");
    if (!host) return;
    const closeBtn = $("shareClose");
    if (closeBtn) closeBtn.addEventListener("click", closeShare);
    host.addEventListener("click", (e) => { if (e.target === host) closeShare(); });
    const grid = $("shareGrid");
    if (grid) grid.addEventListener("click", (e) => {
      const btn = e.target.closest(".share-item");
      if (!btn || !shareCtx) return;
      const ch = btn.dataset.channel;
      const url = shareCtx.url, title = shareCtx.title;
      if (ch === "copy") { copyShareUrl(url); return; }
      if (ch === "wechat") {
        if (IN_WECHAT) { toast("点右上角 ··· 发送给朋友"); return; }
        renderShareQr(url);            // 非微信环境：二维码是最通用的「发到手机 / 微信」通道
        return;
      }
      if (ch === "system") {
        if (typeof navigator.share === "function") navigator.share({ title, url }).catch(() => {});
        return;
      }
      // 官方分享 URL（不做中间跳转，直接开新窗口）
      const target = {
        weibo: "https://service.weibo.com/share/share.php?url=" + encodeURIComponent(url) + "&title=" + encodeURIComponent(title),
        x: "https://twitter.com/intent/tweet?url=" + encodeURIComponent(url) + "&text=" + encodeURIComponent(title),
        telegram: "https://t.me/share/url?url=" + encodeURIComponent(url) + "&text=" + encodeURIComponent(title),
      }[ch];
      if (target) window.open(target, "_blank", "noopener,noreferrer");
    });
    const linkCopy = $("shareLinkCopy");
    if (linkCopy) linkCopy.addEventListener("click", () => copyShareUrl(shareCtx ? shareCtx.url : ""));
    const copyTitle = $("shareCopyTitle");
    if (copyTitle) copyTitle.addEventListener("click", () => {
      if (!shareCtx) return;
      copyShareUrl(shareCtx.title ? shareCtx.title + "\n" + shareCtx.url : shareCtx.url, "已复制标题和链接");
    });
    const linkInput = $("shareLink");
    if (linkInput) linkInput.addEventListener("click", () => { try { linkInput.select(); } catch (_) {} });
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
    // 与分享按钮共用同一个 URL 构造：同样必须走 canonical 路径（location.pathname 会把 /index.html 写进 og:url）
    const url = postShareUrl(post.slug);
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
    // 先摘掉上一次的监听：本函数每打开一篇文章就调用一次，
    // 若不移除，读 N 篇后滚动一次会触发 N 个 handler，且旧闭包持有已卸载的 .post-body
    // 引用，每次滚动都做无用的 getBoundingClientRect + offsetHeight 强制重排。
    if (progressHandler) { window.removeEventListener("scroll", progressHandler); progressHandler = null; }
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
    progressHandler = update;
    window.addEventListener("scroll", progressHandler, { passive: true });
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
      // ⚠️ 一律从动态接口取**原始**正文，不要图省事直接用 currentPost。
      // currentPost 来自静态快照，而快照正文为了瘦身已把内嵌图片抽成了
      // /generated/body-images/… 构建产物路径（build.mjs）。拿它预填编辑器，
      // 用户只改几个字一保存，就会把产物路径写回 D1 → 原始 data: 图片永久丢失
      // （与封面那次同类事故 3afafdd，只是对象换成了正文里的图）。
      // 动态接口返回的是 D1 里的原文，永远是可以安全回存的那一份。
      try {
        const res = await fetch("/api/posts/detail", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: s }) });
        const data = await res.json();
        if (data.ok && data.post) { openCompose(data.post); return; }
        throw new Error((data && data.error) || res.status);
      } catch (e) {
        // 取不到原文就**不进编辑器**：宁可让用户重试，也不能拿快照正文顶替（那会毁掉原图）
        console.error("[compose] 载入原始正文失败", s, e);
        toast("无法载入文章原文，请稍后重试");
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
      // 「分享」打开面板（渠道在里面选）；「复制链接」直连，少一次点击
      if (shareBtn.dataset.share === "open") {
        const slug = shareBtn.dataset.slug;
        if (currentPost && currentPost.slug === slug) openShare(currentPost);
        return;
      }
      const url = shareBtn.dataset.url || (currentPost ? postShareUrl(currentPost.slug) : "");
      if (!shareBtn.dataset.label) shareBtn.dataset.label = shareBtn.textContent.trim();
      copyShareUrl(url).then((ok) => {
        if (!ok) return;
        shareBtn.textContent = "✅ 已复制";
        setTimeout(() => { shareBtn.textContent = shareBtn.dataset.label; }, 1800);
      });
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
    // 切视图时收起移动端抽屉（统一走 setSidebar，保证遮罩/滚动锁/aria 同步）
    setSidebar(false);
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
    // 同步移动端浏览器 UI 配色（地址栏/状态栏）。用单条 meta 由 JS 管，才能跟随站内主题开关，
    // 而不是只跟随系统 prefers-color-scheme —— 用户在深色系统里手动切了浅色主题也不会割裂。
    const tc = document.getElementById("theme-color");
    if (tc) tc.setAttribute("content", mode === "dark" ? "#2A2621" : "#F5EFE6");
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
  const pad2 = (n) => String(n).padStart(2, "0");

  // ===== LUNAR-INLINE-START =====
  // 内联农历（替代原先 426KB / br 110KB 的 assets/vendor/lunar.js）。
  //
  // 为什么：本站只用到「农历日期 / 干支生肖 / 24 节气 / 农历月历」四样，却要为每个访客
  // 下载一个外部脚本。而它有一个致命的失败模式 —— 文档卸载会中止未完成的请求，且
  // max-age 缓存只有**下载完成**后才写入，于是「刷得比下载快就永远下不完」：连续刷新
  // 时农历一直都是空的。内联后数据随 app.js 一起到达，这一整类问题不复存在
  // （连带删掉了加载状态机 / 退避重试 / 看门狗 / 预加载）。
  //
  // 数据由 scripts/gen-lunar-data.mjs 从原库导出：202 年农历年表 + 4872 个节气日，
  // 原始约 6.3KB、gzip 后不足 1KB。运行时只做「日数推算」，没有任何天文计算。
  // 正确性由 scripts/verify-lunar-core.mjs 对着黄金基准逐日全量比对（见 docs/lunar-inline.md）。
  //
  // LUNAR_YEAR_INFO 每年一项（覆盖 1899..2100）：
  //   低 4 位 = 闰月月份（0 = 无闰月）；bit16 = 闰月是大月；bit15..4 = 正月..腊月是否大月
  var LUNAR_Y0 = 1899;
  var LUNAR_YEAR_INFO = [
    0xab50,0x4bd8,0x4ae0,0xa570,0x54d5,0xd260,0xd950,0x16554,0x56a0,
    0x9ad0,0x55d2,0x4ae0,0xa5b6,0xa4d0,0xd250,0x1d255,0xb540,0xd6a0,
    0xada2,0x95b0,0x14977,0x4970,0xa4b0,0xb4b5,0x6a50,0x6d40,0x1ab54,
    0x2b60,0x9570,0x52f2,0x4970,0x6566,0xd4a0,0xea50,0x16a95,0x5ad0,
    0x2b60,0x186e3,0x92e0,0x1c8d7,0xc950,0xd4a0,0x1d8a6,0xb550,0x56a0,
    0x1a5b4,0x25d0,0x92d0,0xd2b2,0xa950,0xb557,0x6ca0,0xb550,0x15355,
    0x4da0,0xa5b0,0x14573,0x52b0,0xa9a8,0xe950,0x6aa0,0xaea6,0xab50,
    0x4b60,0xaae4,0xa570,0x5260,0xf263,0xd950,0x5b57,0x56a0,0x96d0,
    0x4dd5,0x4ad0,0xa4d0,0xd4d4,0xd250,0xd558,0xb540,0xb6a0,0x195a6,
    0x95b0,0x49b0,0xa974,0xa4b0,0xb27a,0x6a50,0x6d40,0xaf46,0xab60,
    0x9570,0x4af5,0x4970,0x64b0,0x74a3,0xea50,0x6b58,0x5ac0,0xab60,
    0x96d5,0x92e0,0xc960,0xd954,0xd4a0,0xda50,0x7552,0x56a0,0xabb7,
    0x25d0,0x92d0,0xcab5,0xa950,0xb4a0,0xbaa4,0xad50,0x55d9,0x4ba0,
    0xa5b0,0x15176,0x52b0,0xa930,0x7954,0x6aa0,0xad50,0x5b52,0x4b60,
    0xa6e6,0xa4e0,0xd260,0xea65,0xd530,0x5aa0,0x76a3,0x96d0,0x4afb,
    0x4ad0,0xa4d0,0x1d0b6,0xd250,0xd520,0xdd45,0xb5a0,0x56d0,0x55b2,
    0x49b0,0xa577,0xa4b0,0xaa50,0x1b255,0x6d20,0xada0,0x14b63,0x9370,
    0x49f8,0x4970,0x64b0,0x168a6,0xea50,0x6b20,0x1a6c4,0xaae0,0x92e0,
    0xd2e3,0xc960,0xd557,0xd4a0,0xda50,0x5d55,0x56a0,0xa6d0,0x55d4,
    0x52d0,0xa9b8,0xa950,0xb4a0,0xb6a6,0xad50,0x55a0,0xaba4,0xa5b0,
    0x52b0,0xb273,0x6930,0x7337,0x6aa0,0xad50,0x14b55,0x4b60,0xa570,
    0x54e4,0xd160,0xe968,0xd520,0xdaa0,0x16aa6,0x56d0,0x4ae0,0xa9d4,
    0xa2d0,0xd150,0xf252,0xd520
  ];
  // 24 节气日：自 1899 年起每年 24 个，'0'-'9' 表示 1..9 日，'a'-'n' 表示 10..23 日
  var LUNAR_JIEQI_DAYS =
    "5k4j6l5k6l6l7n8n8n8n7m7m6k4j6l5k6l6m7n8n8n9o8n7m6l4j6l5l6m6m8n8o8o9o8n8m6l5j6l6l6m7m8o8o8o9o8n8n6l5k" +
    "7m6l7m7m8o9o9o9o8n8n7l5k6l5k6l6m7n8n8n9o8n7m6l4j6l5l6m6m8n8o8o9o8n8m6l5j6l6l6m6m8o8o8o9o8n8n6l5k7m6l" +
    "7m7m8o9o9o9o8n8n7l5k6l5k6l6m7n8n8n9o8n7m6l4j6l5l6m6m8n8o8o9o8n8m6l5j6l6l6m6m8o8o8o9o8n8n6l5k7m6l7m7m" +
    "8o9o9o9o8n8n7l5k6l5k6l6m7n8n8n9o8m7m6k4j6l5l6m6m8n8o8n9o8n8m6l4j6l5l6m6m8o8o8o9o8n8n6l5k6m6l6m7m8o8o" +
    "9o9o8n8n6l5k6l5k6l6m7n8n8n8o8m7m6k4j6l5l6l6m8n8o8n9o8n8m6l4j6l5l6m6m8o8o8o9o8n8m6l5k6m6l6m7m8o8o9o9o" +
    "8n8n6l5k6l5k6l6m7n8n8n8o8m7m6k4j6l5k6l6m8n8o8n9o8n7m6l4j6l5l6m6m8o8o8o9o8n8m6l5j6l6l6m7m8o8o9o9o8n8n" +
    "6l5k6l5k6l6m7n8n8n8o8m7m6k4j6l5k6l6m8n8o8n9o8n7m6l4j6l5l6m6m8n8o8o9o8n8m6l5j6l6l6m7m8o8o9o9o8n8n6l5k" +
    "6l5k6l6m7n8n8n8n7m7m6k4j6l5k6l6m7n8n8n9o8n7m6l4j6l5l6m6m8n8o8o9o8n8m6l5j6l6l6m7m8o8o8o9o8n8n6l5k6l5k" +
    "6l6l7n8n8n8n7m7m6k4j6l5k6l6m7n8n8n9o8n7m6l4j6l5l6m6m8n8o8o9o8n8m6l5j6l6l6m6m8o8o8o9o8n8n6l5k6l5k6l6l" +
    "7n8n8n8n7m7m6k4j6l5k6l6m7n8n8n9o8n7m6l4j6l5l6m6m8n8o8o9o8n8m6l5j6l6l6m6m8o8o8o9o8n8n6l5k6l5k6l6l7n8n" +
    "8n8n7m7m6k4j6l5k6l6m7n8n8n9o8n7m6l4j6l5l6m6m8n8o8o9o8n8m6l5j6l6l6m6m8o8o8o9o8n8n6l5k6l5k5l6l7n8n8n8n" +
    "7m7m6k4j6l5k6l6m7n8n8n8o8m7m6k4j6l5l6m6m8n8o8n9o8n8m6l4j6l5l6m6m8o8o8o9o8n8n6l5k5l5k5l6l7n7n8n8n7m7m" +
    "5k4j6l5k6l6m7n8n8n8o8m7m6k4j6l5k6l6m8n8o8n9o8n8m6l4j6l5l6m6m8o8o8o9o8n8n6l5k5l5k5l6l7n7n8n8n7m7m5k4j" +
    "6l5k6l6m7n8n8n8o8m7m6k4j6l5k6l6m8n8o8n9o8n7m6l4j6l5l6m6m8n8o8o9o8n8m6l5k5k5k5l6l7n7n8n8n7m7m5k4j6l5k" +
    "6l6m7n8n8n8o8m7m6k4j6l5k6l6m7n8n8n9o8n7m6l4j6l5l6m6m8n8o8o9o8n8m6l5j5k5k5l6l7n7n7n8n7m7m5k4j6l5k6l6l" +
    "7n8n8n8n7m7m6k4j6l5k6l6m7n8n8n9o8n7m6l4j6l5l6m6m8n8o8o9o8n8m6l5j5k5k5l6l7n7n7n8n7m7m5k4j6l5k6l6l7n8n" +
    "8n8n7m7m6k4j6l5k6l6m7n8n8n9o8n7m6l4j6l5l6m6m8n8o8o9o8n8m6l5j5k5k5l5l7n7n7n8n7m7m5k4j6l5k6l6l7n8n8n8n" +
    "7m7m6k4j6l5k6l6m7n8n8n9o8n7m6l4j6l5l6m6m8n8o8o9o8n8m6l5j5k5k5l5l7n7n7n8n7m7m5k4j6l5k5l6l7n8n8n8n7m7m" +
    "6k4j6l5k6l6m7n8n8n9o8n7m6l4j6l5l6m6m8n8o8n9o8n8m6l5j5k4k5l5l7n7n7n8n7m7m5k4j6l5k5l6l7n7n8n8n7m7m6k4j" +
    "6l5k6l6m7n8n8n8o8n7m6k4j6l5l6l6m8n8o8n9o8n8m6l5j5k4k5l5l7n7n7n8n7m7m5k4j6l5k5l6l7n7n8n8n7m7m6k4j6l5k" +
    "6l6m7n8n8n8o8m7m6k4j6l5k6l6m8n8o8n9o8n8m6l4j5k4k5l5l7m7n7n8n7m7m5k4j5l5k5l6l7n7n8n8n7m7m5k4j6l5k6l6m" +
    "7n8n8n8o8m7m6k4j6l5k6l6m7n8o8n9o8n7m6l4j5k4k5l5l7m7n7n8n7m7l5k4j5k5k5l6l7n7n7n8n7m7m5k4j6l5k6l6l7n8n" +
    "8n8o8m7m6k4j6l5k6l6m7n8n8n9o8n7m6l4j5k4k5l5l7m7n7n8n7m7l5k4i5k5k5l6l7n7n7n8n7m7m5k4j6l5k6l6l7n8n8n8n" +
    "7m7m6k4j6l5k6l6m7n8n8n9o8n7m6l4j5k4k5l5l7m7n7n8n7m7l5k4i5k5k5l5l7n7n7n8n7m7m5k4j6l5k6l6l7n8n8n8n7m7m" +
    "6k4j6l5k6l6m7n8n8n9o8n7m6l4j5k4k5l5l7m7n7n8n7m7l5k4i5k5k5l5l7n7n7n8n7m7m5k4j6l5k6l6l7n8n8n8n7m7m6k4j" +
    "6l5k6l6m7n8n8n9o8n7m6l4j5k4k5l5l7m7n7n8n7m7l5k4i5k5k5l5l7n7n7n8n7m7m5k4j6l5k5l6l7n7n8n8n7m7m6k4j6l5k" +
    "6l6m7n8n8n9o8n7m6l4j5k4k5l5l7m7n7m8n7m7l5k4i5k4k5l5l7n7n7n8n7m7m5k4j6l5k5l6l7n7n8n8n7m7m6k4j6l5k6l6m" +
    "7n8n8n8o8n7m6l4j5k4k5k5l7m7n7m8n7m7l5k4i5k4k5l5l7m7n7n8n7m7m5k4j6l5k5l6l7n7n8n8n7m7m6k4j6l5k6l6m7n8n" +
    "8n8o8m7m6k4j5k4j5k5l7m7n7m8n7m7l5k3i5k4k5l5l7m7n7n8n7m7m5k4j5l5k5l6l7n7n8n8n7m7m5k4j6l5k6l6l7n8n8n8o" +
    "8m7m6k4j5k4j5k5l6m7m7m8n7m7l5k3i5k4k5l5l7m7n7n8n7m7l5k4j5k5k5l6l7n7n7n8n7m7m5k4j6l5k6l6l7n8n8n8o8m7m" +
    "6k4j5k4j5k5l6m7m7m8n7m6l5k3i5k4k5l5l7m7n7n8n7m7l5k4i5k5k5l5l7n7n7n8n7m7m5k4j6l5k6l6l7n8n8n8n7m7m6k4j" +
    "5k4j5k5l6m7m7m8n7m6l5k3i5k4k5l5l7m7n7n8n7m7l5k4i5k5k5l5l7n7n7n8n7m7m5k4j6l5k6l6l7n8n8n8n7m7m6k4j5k4j" +
    "5k5l6m7m7m8n7m6l5k3i5k4k5l5l7m7n7n8n7m7l5k4i5k5k5l5l7n7n7n8n7m7m5k4j6l5k5l6l7n7n8n8n7m7m6k4j5k4j5k5l" +
    "6m7m7m8n7m6l5k3i5k4k5l5l7m7n7n8n7m7l5k4i5k5k5l5l7n7n7n8n7m7m5k4j6l5k5l6l7n7n8n8n7m7m6k4j5k4j5k5l6m7m" +
    "7m8n7m6l5k3i5k4k5k5l7m7n7m8n7m7l5k4i5k4k5l5l7n7n7n8n7m7m5k4j6l5k5l6l7n7n8n8n7m7m6k4j5k4j5k5l6m7m7m7n" +
    "7m6l5k3i5k4j5k5l7m7n7m8n7m7l5k4i5k4k5l5l7m7n7n8n7m7m5k4j6l5k5l6l7n7n8n8n7m7m6k4j5k4j5k5k6m7m7m7n7l6l" +
    "5j3i5k4j5k5l6m7m7m8n7m7l5k3i5k4k5l5l7m7n7n8n7m7m5k4j5k5k5l6l7n7n7n8n7m7m5k4j5k4j5k5k6m7m7m7n7l6l5j3i" +
    "5k4j5k5l6m7m7m8n7m7l5k3i5k4k5l5l7m7n7n8n7m7m5k4j5k5k5l5l7n7n7n8n7m7m5k4j5k4j5k5k6m7m7m7n7l6l5j3i5k4j" +
    "5k5l6m7m7m8n7m6l5k3i5k4k5l5l7m7n7n8n7m7l5k4j5k5k5l5l7n7n7n8n7m7m5k4j5k4j5k5k6m7m7m7m6l6l5j3i5k4j5k5l" +
    "6m7m7m8n7m6l5k3i5k4k5l5l7m7n7n8n7m7l5k4i5k5k5l5l7n7n7n8n7m7m5k4j5k4j5k5k6m7m7m7m6l6l5j3i5k4j5k5l6m7m" +
    "7m8n7m6l5k3i5k4k5l5l7m7n7n8n7m7l5k4i5k5k5l5l7n7n7n8n7m7m5k4j5k4j4k5k6m6m7m7m6l6l5j3i5k4j5k5l6m7m7m8n" +
    "7m6l5k3i5k4k5k5l7m7n7m8n7m7l5k4i5k5k5l5l7n7n7n8n7m7m5k4j5k4j4k5k6m6m7m7m6l6l5j3i5k4j5k5l6m7m7m7n7m6l" +
    "5k3i5k4k5k5l7m7n7m8n7m7l5k4i5k4k5l5l7m7n7n8n7m7m5k4j5k4j4k5k6m6m7m7m6l6l5j3i5k4j5k5l6m7m7m7n7m6l5k3i" +
    "5k4j5k5l6m7n7m8n7m7l5k4i5k4k5l5l7m7n7n8n7m7m5k4j5k4j4k5k6m6m7m7m6l6l5j3i5k4j5k5k6m7m7m7n7l6l5k3i5k4j" +
    "5k5l6m7m7m8n7m7l5k3i5k4k5l5l7m7n7n8n7m7m5k4j4j4j4k5k6m6m6m7m6l6l4j3i5k4j5k5k6m7m7m7n7l6l5j3i5k4j5k5l" +
    "6m7m7m8n7m7l5k3i5k4k5l5l7m7n7n8n7m7m5k4j4j4j4k4k6m6m6m7m6l6l4j3i5k4j5k5k6m7m7m7n7l6l5j3i5k4j5k5l6m7m" +
    "7m8n7m6l5k3i5k4k5l5l7m7n7n8n7m7l5k4j4j4j4k4k6m6m6m7m6l6l4j3i5k4j5k5k6m7m7m7m6l6l5j3i5k4j5k5l6m7m7m8n" +
    "7m6l5k3i5k4k5l5l7m7n7n8n7m7l5k4i4j4j4k4k6m6m6m7m6l6l4j3i5k4j5k5k6m6m7m7m6l6l5j3i5k4j5k5l6m7m7m8n7m6l" +
    "5k3i5k4k5l5l7m7n7n8n7m7l5k4i5k5k5l5l7n7n7n8n7m7m5k4j6l5k5l6l7n7n8n8n7m7m";
  var LUNAR_JIEQI_NAMES = ["小寒","大寒","立春","雨水","惊蛰","春分","清明","谷雨","立夏","小满","芒种","夏至","小暑","大暑","立秋","处暑","白露","秋分","寒露","霜降","立冬","小雪","大雪","冬至"];
  var LUNAR_MONTH_CN = "正二三四五六七八九十冬腊";
  var LUNAR_GAN = "甲乙丙丁戊己庚辛壬癸";
  var LUNAR_ZHI = "子丑寅卯辰巳午未申酉戌亥";
  var LUNAR_SX = "鼠牛虎兔龙蛇马羊猴鸡狗猪";
  var LUNAR_ANCHOR = Date.UTC(1900, 0, 31) / 86400000;   // 农历 1900 年正月初一
  var LUNAR_MIN_DAY = Date.UTC(1899, 11, 1) / 86400000;   // 支持范围下限
  var LUNAR_MAX_DAY = Date.UTC(2100, 11, 31) / 86400000;

  function lYearDays(y) {
    var info = LUNAR_YEAR_INFO[y - LUNAR_Y0], sum = 348;
    for (var i = 0x8000; i > 0x8; i >>= 1) if (info & i) sum++;
    return sum + lLeapDays(y);
  }
  function lLeapMonth(y) { return LUNAR_YEAR_INFO[y - LUNAR_Y0] & 0xf; }
  function lLeapDays(y) { return lLeapMonth(y) ? ((LUNAR_YEAR_INFO[y - LUNAR_Y0] & 0x10000) ? 30 : 29) : 0; }
  function lMonthDays(y, m) { return m < 0 ? lLeapDays(y) : ((LUNAR_YEAR_INFO[y - LUNAR_Y0] & (0x10000 >> m)) ? 30 : 29); }
  // 自当年正月初一算起，到「第 m 月」初一经过的天数（m < 0 表示闰月）
  function lDaysBeforeMonth(y, m) {
    var lp = lLeapMonth(y), leap = m < 0, t = leap ? -m : m, sum = 0;
    for (var i = 1; i <= (leap ? t : t - 1); i++) {
      sum += lMonthDays(y, i);
      if (i === lp && !(leap && i === t)) sum += lLeapDays(y);
    }
    return sum;
  }
  // 公历日 → 天数序号。用 UTC 计算，避开夏令时/时区把结果推成 0.5 天
  function lSolarNum(y, m, d) { return Date.UTC(y, m - 1, d) / 86400000; }
  function lYearOffset(y) {
    var n = 0, i;
    if (y >= 1900) { for (i = 1900; i < y; i++) n += lYearDays(i); }
    else { for (i = y; i < 1900; i++) n -= lYearDays(i); }
    return n;
  }
  function lToSolarNum(y, m, d) { return lYearOffset(y) + lDaysBeforeMonth(y, m) + (d - 1); }
  // 天数序号 → 农历 y/m/d（m < 0 表示闰月）
  function lFromSolarNum(n) {
    var off = n, y = 1900;
    if (off >= 0) { while (off >= lYearDays(y)) { off -= lYearDays(y); y++; } }
    else { while (off < 0) { y--; off += lYearDays(y); } }
    var lp = lLeapMonth(y), m = 1;
    for (var i = 1; i <= 12; i++) {
      var len = lMonthDays(y, i);
      if (off < len) { m = i; break; }
      off -= len;
      if (i === lp) {
        var ll = lLeapDays(y);
        if (off < ll) { m = -i; break; }
        off -= ll;
      }
    }
    return { y: y, m: m, d: off + 1 };
  }
  function lJieQiDay(y, n) {
    var c = LUNAR_JIEQI_DAYS.charCodeAt((y - LUNAR_Y0) * 24 + n);
    return c < 58 ? c - 48 : c - 87;
  }
  function lJieQiOf(y, m, d) {
    for (var k = 0; k < 2; k++) {
      var n = (m - 1) * 2 + k;
      if (lJieQiDay(y, n) === d) return LUNAR_JIEQI_NAMES[n];
    }
    return null;
  }
  // 下一个节气：严格晚于今天（与旧库 getNextJieQi(true) 一致 —— 当天是节气时返回再下一个）
  function lNextJieQi(y, m, d) {
    for (var n = (m - 1) * 2; n < 24; n++) {
      var nm = (n >> 1) + 1, dd = lJieQiDay(y, n);
      if (nm > m || dd > d) return { name: LUNAR_JIEQI_NAMES[n], y: y, m: nm, d: dd };
    }
    return { name: LUNAR_JIEQI_NAMES[0], y: y + 1, m: 1, d: lJieQiDay(y + 1, 0) };
  }
  function lGanZhi(y) { return LUNAR_GAN.charAt((y - 4) % 10) + LUNAR_ZHI.charAt((y - 4) % 12); }
  function lShengXiao(y) { return LUNAR_SX.charAt((y - 4) % 12); }
  function lMonthCn(m) { return (m < 0 ? "闰" : "") + LUNAR_MONTH_CN.charAt((m < 0 ? -m : m) - 1); }
  function lDayCn(d) {
    var A = "一二三四五六七八九十";
    if (d === 10) return "初十";
    if (d === 20) return "二十";
    if (d === 30) return "三十";
    return (d < 10 ? "初" : d < 20 ? "十" : "廿") + A.charAt((d < 10 ? d : d % 10) - 1);
  }
  // 一天的农历信息（hero 行与侧栏挂件共用）。超出支持范围返回 null，调用方降级显示。
  function lunarOf(date) {
    var y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
    var num = lSolarNum(y, m, d);
    if (num < LUNAR_MIN_DAY || num > LUNAR_MAX_DAY) return null;
    var lu = lFromSolarNum(num - LUNAR_ANCHOR);
    return {
      y: lu.y, m: lu.m, d: lu.d,
      month: lMonthCn(lu.m), day: lDayCn(lu.d),
      ganZhi: lGanZhi(lu.y), shengXiao: lShengXiao(lu.y),
      jieQi: lJieQiOf(y, m, d),
      next: lNextJieQi(y, m, d),
    };
  }
  function lunarMonthDays(y, m) { return lMonthDays(y, m); }
  function lunarToSolar(y, m, d) {
    var dt = new Date((lToSolarNum(y, m, d) + LUNAR_ANCHOR) * 86400000);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }
  function solarWeekday(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
  // ===== LUNAR-INLINE-END =====

  let heroLineKey = "";       // hero 行的渲染签名，避免每秒重建 DOM
  let lunarDetailDayKey = ""; // 详细农历（节气/整月月历）已渲染的日期，避免每秒重算
  const narrowMQ = window.matchMedia("(max-width: 980px)");
  const isNarrow = () => narrowMQ.matches;

  function shichenOf(d) {
    const idx = Math.floor(((d.getHours() + 1) % 24) / 2);
    return { idx, name: DI_ZHI[idx] };
  }

  // hero 那行「农历 + 时辰 + 时间」：每秒调用，必须极轻 —— 只在「跨日 / 换时辰」时重建，
  // 其余每一拍仅改秒数文本。农历数据已内联在 app.js 里，不必再等任何外部资源。
  function tickClock() {
    const el = $("lunarClock");
    if (!el) return;
    const now = new Date();
    const sc = shichenOf(now);
    const time = pad2(now.getHours()) + ":" + pad2(now.getMinutes()) + ":" + pad2(now.getSeconds());
    const dayKey = now.getFullYear() + "-" + (now.getMonth() + 1) + "-" + now.getDate();
    const key = dayKey + "|" + sc.name;
    if (key === heroLineKey) {
      const t = el.querySelector(".lunar-time");
      if (t) { t.textContent = time; return; }
    }
    heroLineKey = key;
    const lu = lunarOf(now);
    if (lu) {
      // 生肖单独包一层：窄屏宽度紧张，用 CSS 隐掉它 —— 农历日期本身必须留下，
      // 因为窄屏右侧栏整体隐藏，这行是唯一能看到农历的地方。
      el.innerHTML = "🗓 " + lu.ganZhi + "年<span class=\"lunar-sx\">（" + lu.shengXiao + "）</span>" +
        lu.month + "月" + lu.day +
        " · <strong>" + sc.name + "时</strong> <span class=\"lunar-time\">" + time + "</span>";
      el.title = "农历：" + lu.ganZhi + "年" + lu.month + "月" + lu.day +
        " · " + sc.name + "时（" + SHICHEN_RANGE[sc.idx] + "）";
    } else {
      // 只可能是系统时间被调到支持范围（1899–2100）之外，降级为纯时辰，不留空
      el.innerHTML = "🕐 <strong>" + sc.name + "时</strong> <span class=\"lunar-time\">" + time + "</span>";
      el.title = "时辰：" + sc.name + "时（" + SHICHEN_RANGE[sc.idx] + "）";
    }
  }

  // 详细农历挂件（右侧栏）：节气 + 整月月历属于「一天只变一次」的重活，按日缓存。
  // 原实现把它挂在 1 秒定时器里 —— 等于每秒重算节气并重建 42 个日历格子，必须避免。
  function renderLunarDetails() {
    const now = new Date();
    const dayKey = now.getFullYear() + "-" + (now.getMonth() + 1) + "-" + now.getDate();
    if (dayKey === lunarDetailDayKey) return;
    const gzEl = $("lunarGanZhi");
    const monthEl = $("lunarMonth");
    const jqEl = $("lunarJieQi");
    const daysEl = $("lunarDays");
    const scEl = $("lunarShiChen");
    if (!gzEl && !monthEl && !jqEl && !daysEl && !scEl) return; // 挂件不在页面上（404 页复用本脚本）
    const lu = lunarOf(now);
    if (!lu) return;                                            // 系统时间超出支持范围，保留占位
    lunarDetailDayKey = dayKey;
    const sc = shichenOf(now);
    if (gzEl) gzEl.textContent = `${lu.ganZhi}年 · ${lu.shengXiao}`;
    if (monthEl) monthEl.textContent = `农历 ${lu.month}月 · ${lu.day}`;
    if (scEl) scEl.textContent = `${sc.name}时（${SHICHEN_RANGE[sc.idx]}）`;

    // 24节气：今日节气 or 下一个节气倒计时
    if (jqEl) {
      if (lu.jieQi) {
        jqEl.textContent = `今日节气 · ${lu.jieQi}`;
      } else if (lu.next) {
        const todayNum = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
        const diff = Math.round((Date.UTC(lu.next.y, lu.next.m - 1, lu.next.d) - todayNum) / 86400000);
        jqEl.textContent = diff === 1 ? `明日节气 · ${lu.next.name}` : `${diff} 天后 · ${lu.next.name}`;
      } else { jqEl.textContent = ""; }
    }

    // 当月农历月历格子（像日历那样显示整月）
    if (daysEl) {
      try {
        const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
        const dayCount = lunarMonthDays(lu.y, lu.m);
        const first = lunarToSolar(lu.y, lu.m, 1);
        const startWeek = solarWeekday(first.y, first.m, first.d); // 0=周日
        const todayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

        let html = weekdays.map((w) => `<div class="lunar-cal-head">${w}</div>`).join("");
        // 前置空白
        for (let i = 0; i < startWeek; i++) html += `<div class="lunar-cal-cell empty"></div>`;
        // 日期格子
        for (let d = 1; d <= dayCount; d++) {
          const sd = lunarToSolar(lu.y, lu.m, d);
          const isToday = `${sd.y}-${sd.m}-${sd.d}` === todayKey;
          html += `<div class="lunar-cal-cell ${isToday ? "today" : ""}"><span class="cal-solar">${sd.d}</span><span class="cal-lunar">${lDayCn(d)}</span></div>`;
        }
        // 补齐最后一行
        const totalCells = startWeek + dayCount;
        const tail = (7 - (totalCells % 7)) % 7;
        for (let i = 0; i < tail; i++) html += `<div class="lunar-cal-cell empty"></div>`;
        daysEl.innerHTML = `<div class="lunar-calendar">${html}</div>`;
      } catch (e) { console.error("[lunar] 月历渲染失败", e); daysEl.textContent = "—"; }
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
  if (!isNarrow()) updateSideClock();
  // 单一秒级定时器（原来是两个，农历/时钟各被跑了两遍）。窄屏右侧栏整体 display:none，
  // 直接不跑挂件计算。
  setInterval(() => {
    tickClock();
    if (isNarrow()) return;
    renderLunarDetails();
    updateSideClock();
  }, 1000);

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
  // 状态变量（currentUser / currentSlug / currentPost 等）已全部移至 IIFE 顶部声明，
  // 见文件开头的「⚠️ 以下状态变量必须全部声明在 IIFE 顶部」注释，此处不再重复声明（会造成 TDZ）。
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

  // 会话校验去重。启动时（见文件末尾）与「打开文章」都会想要 currentUser，
  // 原先两边各发一次 /api/me —— 实测同一页面出现**两次**请求（+240ms 与 +565ms），
  // 白等一个跨境往返（~190ms）。这里共用一个 promise：
  // 谁先要谁发起，后到的直接复用同一次结果。
  // 失败（网络异常）时把 promise 清掉，允许下次重试，避免一次抖动被永久钉死。
  function ensureSession() {
    if (!sessionPromise) {
      sessionPromise = checkSession()
        .then((u) => { sessionReady = true; return u; })
        .catch(() => { sessionPromise = null; sessionReady = false; return null; });
    }
    return sessionPromise;
  }

  // ===== 网页字体（非阻塞注入）=====
  // 为什么不在 index.html 里直接写 <link rel="stylesheet">：
  // 那条样式表未压缩 339KB / gzip 91KB，且是**跨站**资源。它是渲染阻塞的 ——
  // 实测冷缓存要 460~590ms 才到，首屏所有内容（文章、侧栏、挂件）会一起等它，
  // 把首绘从约 900ms 拖到 1296ms。字体本身只是外观增强（系统衬线栈随时兜底），
  // 让它拖住整页首绘完全不划算。
  // 动态插入的 <link> 不参与渲染阻塞：字体到达后由 font-display:swap 自然替换。
  // data-optional 让 index.html 的全局 error 监听忽略它的失败 —— 字体下不来不该弹「资源加载失败」。
  // ⚠️ 不要改成 media="print" onload="this.media='all'"：小米/360 兼容模式对该切换支持不良，
  //    会导致样式表永远不生效（项目已因此回滚过一次，见 index.html 里 style.css 上方的注释）。
  const FONT_CSS_URL = "https://fonts.font.im/css2?family=Noto+Serif+SC:wght@400;700;900&display=swap";
  function loadWebFont() {
    try {
      if (document.querySelector("link[data-web-font]")) return;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = FONT_CSS_URL;
      link.setAttribute("data-web-font", "1");
      link.setAttribute("data-optional", "1");
      document.head.appendChild(link);
    } catch (e) { console.error("[font] 网页字体注入失败", e); }
  }
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
    memberArea.innerHTML = `<div class="member-welcome"><div class="member-card"><div class="member-avatar">${escapeHtml((user.username || "?").slice(0,1).toUpperCase())}</div><div><h2>欢迎，${escapeHtml(user.username)} 👋</h2><p class="member-sub">你已登录会员专区。</p></div></div><div class="member-perks"><div class="perk">✍️ 撰写并发布文章</div><div class="perk">📚 会员专享读书笔记合集</div><div class="perk">💬 文章下方专属评论区</div><div class="perk">🔖 收藏你喜欢的文章</div></div><button class="btn-publish" type="button" id="memberPublish">✍️ 现在写一篇文章</button><p class="member-note">更多功能陆续开放。</p></div>`;
    const pb = $("memberPublish"); if (pb) pb.addEventListener("click", openCompose);
  }

  // ===== 全屏写作页 =====
  function openCompose(post) {
    showView("compose");
    composeCoverDirty = false; // 每次打开都重置「封面是否改动」
    if (post && post.slug) {
      editingSlug = post.slug;
      if (composeTitle) composeTitle.value = post.title || "";
      if (composeTag) composeTag.value = post.tag || "";
      if (composeSummary) composeSummary.value = post.summary || "";
      // 封面：快照里的 cover 是构建产物路径（/generated/covers/...），不是用户的原始封面。
      // 预填进去再保存会把它写回 D1，原始 data: 图片就此永久丢失 —— 因此不预填，
      // 并靠 composeCoverDirty 让「未改动」的文章提交时不带 cover 字段（后端保持原值）。
      const loadedCover = post.cover || "";
      if (composeCover) composeCover.value = isArtifactCover(loadedCover) ? "" : loadedCover;
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
    // 快照里的封面是构建产物路径（不入库、每次构建可能改名），不能预填、更不能写回 ——
    // 不填就保持数据库原值不变；要换封面则粘贴新的图片地址。
    if (post && post.slug && isArtifactCover(post.cover) && composeMsg) {
      composeMsg.textContent = "ℹ️ 封面未预填（快照中的封面是构建产物路径）：保持留空即保留原封面不变，要更换请粘贴新的图片地址。";
      composeMsg.className = "form-msg";
    }
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

  // 用户一旦编辑封面输入框，就认为他确实要设置封面（提交时才带上 cover 字段）
  if (composeCover) composeCover.addEventListener("input", () => { composeCoverDirty = true; });

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
      const payload = { title, tag: (composeTag?.value || "").trim(), summary: (composeSummary?.value || "").trim(), body };
      // 编辑且用户没动过封面 → 不提交 cover 字段，后端保持 D1 里的原始值。
      // 否则快照里的构建产物路径（/generated/covers/...）会被写回，覆盖掉原始 data: 封面。
      // 新建文章仍按原逻辑提交（留空则后端自动取正文首图）。
      if (!editingSlug || composeCoverDirty) payload.cover = (composeCover?.value || "").trim();
      if (editingSlug) {
        res = await fetch("/api/posts/manage", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "update", slug: editingSlug, ...payload }) });
      } else {
        res = await fetch("/api/posts", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      }
      data = await res.json();
      if (!res.ok || !data.ok) { if (composeMsg) { composeMsg.textContent = data.error || (editingSlug ? "保存失败" : "发布失败"); composeMsg.className = "form-msg err"; } return; }
      postCache.delete(editingSlug); // 文章有变动，失效详情缓存
      if (composeMsg) {
        composeMsg.innerHTML = data.coverIgnored
          ? "✅ 已保存（提交的封面是构建产物路径，已保留原封面）"
          : (editingSlug ? "✅ 已保存" : "✅ 已发布");
        composeMsg.className = data.coverIgnored ? "form-msg" : "form-msg ok";
      }
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
  // 抽屉开合集中在一处：class / 遮罩 / 滚动锁 / aria-expanded 必须同步，
  // 否则会出现「抽屉关了但 body 还锁着滚动」或「读屏软件不知道菜单已展开」。
  function setSidebar(open) {
    if (sidebar) sidebar.classList.toggle("open", !!open);
    if (sidebarOverlay) sidebarOverlay.hidden = !open;
    document.body.style.overflow = open ? "hidden" : "";
    if (hamburger) hamburger.setAttribute("aria-expanded", String(!!open));
    if (hamburgerTop) hamburgerTop.setAttribute("aria-expanded", String(!!open));
  }
  function toggleSidebar() { setSidebar(!(sidebar && sidebar.classList.contains("open"))); }
  if (hamburger) hamburger.addEventListener("click", toggleSidebar);
  if (sidebarOverlay) sidebarOverlay.addEventListener("click", toggleSidebar);
  if (mainNav) mainNav.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setSidebar(false)));

  // 抽屉右滑关闭：手机上的肌肉记忆是从左缘往右划。
  // 只在抽屉已打开时跟踪；判定「右移 > 60px 且横向位移主打」才关，
  // 一旦纵向位移变大就放弃（让位给抽屉自身的滚动），全部 passive 不阻塞滚动。
  (function enableSidebarSwipe() {
    let startX = 0, startY = 0, tracking = false;
    document.addEventListener("touchstart", (e) => {
      if (!sidebar || !sidebar.classList.contains("open")) return;
      const t = e.touches && e.touches[0]; if (!t) return;
      startX = t.clientX; startY = t.clientY; tracking = true;
    }, { passive: true });
    document.addEventListener("touchmove", (e) => {
      if (!tracking) return;
      const t = e.touches && e.touches[0]; if (!t) return;
      const dx = t.clientX - startX, dy = t.clientY - startY;
      if (dx > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { tracking = false; setSidebar(false); }
      else if (Math.abs(dy) > 40) { tracking = false; } // 变成了纵向滚动，本次不再判定
    }, { passive: true });
    document.addEventListener("touchend", () => { tracking = false; }, { passive: true });
    document.addEventListener("touchcancel", () => { tracking = false; }, { passive: true });
  })();

  // ===== 事件绑定 =====
  if (authBtn) authBtn.addEventListener("click", () => openAuth("login"));
  if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);
  if (authClose) authClose.addEventListener("click", closeAuth);
  bindSharePanel();
  if (authModal) authModal.addEventListener("click", (e) => { if (e.target === authModal) closeAuth(); });
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  if (loginForm) loginForm.addEventListener("submit", handleLogin);
  if (registerForm) registerForm.addEventListener("submit", handleRegister);
  if (publishBtnChip) publishBtnChip.addEventListener("click", openCompose);
  if (composeSubmit) composeSubmit.addEventListener("click", handlePublish);
  // ESC 逐层关闭：分享面板 → 抽屉 → 登录弹窗（灯箱另有独立监听，见上方）
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const shareHost = $("shareModal");
    if (shareHost && !shareHost.hidden) { closeShare(); return; }
    if (sidebar && sidebar.classList.contains("open")) { setSidebar(false); return; }
    if (authModal && !authModal.hidden) closeAuth();
  });

  // ===== 封面图加载失败降级 =====
  // 封面是构建期抽离出的静态文件（/generated/covers/...）。实测线上出现过「列表里登记了封面、
  // 文件却 404」的情况，成因有两类：
  //   ① 浏览器拿到了**过期的列表快照**，里面指向的文件已被新一次构建改名删除；
  //   ② pages.dev 在大陆跨境访问偶发失败（不该一次就放弃）。
  // 策略：先带 cache-buster 重试两次；仍失败且是卡片封面 → 拉一次最新的快照并重渲染
  // （自愈，避免「图全没了而且怎么刷都回不来」）；最后才隐藏，退化成「无封面」排版。
  // 注意：img 的 error 事件不冒泡，必须在捕获阶段监听才能收到。
  let snapshotRefreshTried = false;
  async function tryRefreshSnapshotForCovers() {
    if (snapshotRefreshTried) return false;
    snapshotRefreshTried = true;
    try {
      // reload 强制绕过本地缓存，拿服务端当前快照
      const r = await fetchJSON("/generated/posts.json", { cache: "reload", timeout: 8000 });
      if (!r.ok) return false;
      const d = await r.json();
      if (!d || !d.ok || !Array.isArray(d.posts) || !d.posts.length) return false;
      // 封面路径没变说明不是快照过期（可能纯属网络抖动），不做无谓重渲染
      const changed = JSON.stringify(d.posts.map((p) => p.slug + "|" + (p.cover || ""))) !==
        JSON.stringify(posts.map((p) => p.slug + "|" + (p.cover || "")));
      if (!changed) return false;
      refreshHomeList(d.posts);
      return true;
    } catch (_) { return false; }
  }
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (!img || img.tagName !== "IMG" || !img.classList) return;
    const isCard = img.classList.contains("card-cover-img");
    const isHero = img.classList.contains("post-cover");
    if (!isCard && !isHero) return;
    const tries = Number(img.dataset.coverTries || 0);
    if (tries < 2) {
      // 失败重挂 src，并加 cache-buster（避免命中此前那条失败的缓存条目）。
      // 同步重设会立刻再次触发 error，反而没给网络一次机会，所以延迟重试。
      img.dataset.coverTries = String(tries + 1);
      const src = img.getAttribute("src");
      if (src) {
        img.removeAttribute("src");
        const busted = src + (src.includes("?") ? "&" : "?") + "retry=" + (tries + 1);
        setTimeout(() => img.setAttribute("src", busted), 400 * (tries + 1));
        return;
      }
    }
    if (isCard) {
      // 走到这里说明重试也没救回来：很可能是本地快照过期（封面文件名已变），尝试自愈
      tryRefreshSnapshotForCovers().then((healed) => {
        if (healed) return; // 重渲染后是新的一批 <img>，交给它们自己加载
        img.hidden = true;
        const wrap = img.parentElement;
        if (wrap) wrap.classList.add("cover-failed");
        const card = img.closest(".card");
        if (card) card.classList.add("no-cover"); // 复用无封面卡片的边框与引号排版
      });
      return;
    }
    img.hidden = true;
    const wrap = img.parentElement;
    if (wrap) wrap.classList.add("cover-failed");
  }, true);

  const memberNav = document.querySelector('.nav-link[data-view="member"]');
  if (memberNav) memberNav.addEventListener("click", async () => { const user = await ensureSession(); renderMember(user); });

  // ===== 启动 =====
  // 农历数据就在本文件里，随时可算 —— 没有「加载中」这个状态，也不需要任何重试机制。
  tickClock();
  // 窄 → 宽（横竖屏切换 / 桌面缩放窗口）时侧栏才出现，补一次挂件渲染
  try {
    narrowMQ.addEventListener("change", (e) => {
      heroLineKey = "";
      tickClock();
      if (!e.matches) { renderLunarDetails(); updateSideClock(); }
    });
  } catch (_) {}

  bindInputStates();
  ensureSession();
  loadPosts();

  // 网页字体放到**首绘之后**再注入（两层 rAF ≈ 至少画过一帧）。
  // 注入的是动态 <link>，不参与渲染阻塞，因此不会推迟任何内容的出现；
  // 用户先看到系统衬线体，字体到达后由 font-display:swap 自然替换。
  // 不用 window.load 触发：load 要等封面图（含图文章最大 1.1MB），那时才换字体太晚、跳变更明显。
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(loadWebFont));
  } else {
    setTimeout(loadWebFont, 0);
  }

  // 若 URL 带 ?post=slug，自动打开对应文章（分享链接可用）
  const startParams = new URLSearchParams(location.search);
  const startSlug = startParams.get("post");
  if (startSlug) {
    setTimeout(() => openPost(decodeURIComponent(startSlug)), 300);
  }

})();