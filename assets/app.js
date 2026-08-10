// ===== 博客交互逻辑（数据全部来自本站 /api/posts D1 接口）=====
(function () {
  const archiveList = document.getElementById("archiveList");
  const postDetail = document.getElementById("postDetail");
  const backBtn = document.getElementById("backBtn");
  const navLinks = document.querySelectorAll(".nav-link");
  const views = {
    home: document.querySelector(".view-home"),
    archive: document.querySelector(".view-archive"),
    about: document.querySelector(".view-about"),
    member: document.querySelector(".view-member"),
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

  // ===== 读者会员：登录/注册 =====
  const authBtn = document.getElementById("authBtn");
  const userChip = document.getElementById("userChip");
  const userName = document.getElementById("userName");
  const userAvatar = document.getElementById("userAvatar");
  const logoutBtn = document.getElementById("logoutBtn");
  const publishBtnChip = document.getElementById("publishBtnChip");
  const authModal = document.getElementById("authModal");
  const authClose = document.getElementById("authClose");
  const loginForm = document.getElementById("loginForm");
  const registerForm = document.getElementById("registerForm");
  const loginMsg = document.getElementById("loginMsg");
  const registerMsg = document.getElementById("registerMsg");
  const composeModal = document.getElementById("composeModal");
  const composeClose = document.getElementById("composeClose");
  const composeForm = document.getElementById("composeForm");
  const composeMsg = document.getElementById("composeMsg");
  const composeSubmit = document.getElementById("composeSubmit");
  const memberArea = document.getElementById("memberArea");

  let posts = [];
  let activeTag = "全部";
  let currentSlide = 0;
  let totalSlides = 0;
  let slideTimer = null;

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
  function coverStyle(post) {
    if (post.cover) return `background-image:url('${post.cover}');`;
    return `background:${gradFor(post.title)};`;
  }
  function readingTime(body) {
    const words = (body || "").replace(/\s/g, "").length;
    return Math.max(1, Math.round(words / 350));
  }

  // ===== 数据源：/api/posts =====
  async function fetchAllPosts() {
    const res = await fetch("/api/posts", { credentials: "same-origin" });
    if (!res.ok) throw new Error("list " + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error("bad list");
    return data.posts || [];
  }

  // ===== 特色轮播 =====
  function renderSlider() {
    const top = posts.slice(0, Math.min(5, posts.length));
    if (!top.length) { if (sliderEl) sliderEl.style.display = "none"; return; }
    slidesEl.innerHTML = top
      .map(
        (p, i) => `
      <div class="slide ${i === 0 ? "active" : ""}" data-slug="${p.slug}" style="${coverStyle(p)}">
        <div class="slide-overlay">
          <span class="slide-tag">${p.tag}</span>
          <h3 class="slide-title">${p.title}</h3>
          <p class="slide-summary">${p.summary || ""}</p>
          <button class="slide-read" data-slug="${p.slug}">阅读全文 →</button>
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
          openPost(b.dataset.slug);
        })
      );
    slidesEl
      .querySelectorAll(".slide")
      .forEach((s) => s.addEventListener("click", () => openPost(s.dataset.slug)));
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
      <article class="card" data-slug="${p.slug}">
        <div class="card-cover" style="${coverStyle(p)}"></div>
        <div class="card-body">
          <div class="card-meta">
            <span class="tag">${p.tag}</span>
            <span>${formatDate(p.date)}</span>
            <span>✍ ${p.author}</span>
          </div>
          <h3>${p.title}</h3>
          <p>${p.summary || ""}</p>
          <div class="card-foot"><span>约 ${readingTime(p.body)} 分钟</span><span class="card-go">阅读 →</span></div>
        </div>
      </article>`
      )
      .join("");
    cardGrid
      .querySelectorAll(".card")
      .forEach((el) => el.addEventListener("click", () => openPost(el.dataset.slug)));
  }

  function renderArchive() {
    archiveList.innerHTML = posts
      .map(
        (p) => `
        <div class="archive-item" data-slug="${p.slug}">
          <span class="archive-date">${p.date}</span>
          <span class="archive-title">${p.title}</span>
        </div>`
      )
      .join("");
    archiveList
      .querySelectorAll(".archive-item")
      .forEach((el) => el.addEventListener("click", () => openPost(el.dataset.slug)));
  }

  function openPost(slug) {
    const p = posts.find((x) => x.slug === slug);
    if (!p) return;
    const html = mdToHtml(p.body || "");
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
    if (sliderEl) sliderEl.style.display = "block";
    try {
      posts = (await fetchAllPosts())
        .map((p) => ({
          ...p,
          summary: p.summary || (p.body || "").replace(/[#>*`\-\s]/g, " ").slice(0, 80).trim(),
        }));
    } catch (e) {
      cardGrid.innerHTML = `<p style="color:var(--text-faint)">文章加载失败：${e.message}</p>`;
      if (sliderEl) sliderEl.style.display = "none";
      return;
    }
    if (!posts.length) {
      cardGrid.innerHTML = `<p style="color:var(--text-faint)">暂时没有文章。登录会员即可发第一篇。</p>`;
      if (sliderEl) sliderEl.style.display = "none";
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

  // ===== 读者会员：会话与界面 =====
  function setAuthUI(user) {
    if (user && user.username) {
      if (authBtn) authBtn.hidden = true;
      if (userChip) {
        userChip.hidden = false;
        userName.textContent = user.username;
        userAvatar.textContent = user.username.slice(0, 1).toUpperCase() || "👤";
      }
      if (publishBtnChip) publishBtnChip.hidden = false;
    } else {
      if (authBtn) authBtn.hidden = false;
      if (userChip) userChip.hidden = true;
      if (publishBtnChip) publishBtnChip.hidden = true;
    }
  }

  async function checkSession() {
    try {
      const res = await fetch("/api/me", { credentials: "same-origin" });
      const data = await res.json();
      setAuthUI(data.user);
      return data.user;
    } catch (e) {
      setAuthUI(null);
      return null;
    }
  }

  function openAuth(tab) {
    if (!authModal) return;
    authModal.hidden = false;
    switchTab(tab || "login");
  }
  function closeAuth() {
    if (authModal) authModal.hidden = true;
    if (loginMsg) loginMsg.textContent = "";
    if (registerMsg) registerMsg.textContent = "";
  }
  function switchTab(tab) {
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.tab === tab)
    );
    loginForm.classList.toggle("active", tab === "login");
    registerForm.classList.toggle("active", tab === "register");
  }

  async function handleLogin(e) {
    e.preventDefault();
    const fd = new FormData(loginForm);
    loginMsg.textContent = "登录中…";
    loginMsg.className = "form-msg";
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: fd.get("username"),
          password: fd.get("password"),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        loginMsg.textContent = data.error || "登录失败";
        loginMsg.className = "form-msg err";
        return;
      }
      setAuthUI(data.user);
      closeAuth();
      if (currentViewIsMember()) renderMember(data.user);
    } catch (err) {
      loginMsg.textContent = "网络错误，请重试";
      loginMsg.className = "form-msg err";
    }
  }

  async function handleRegister(e) {
    e.preventDefault();
    const fd = new FormData(registerForm);
    registerMsg.textContent = "注册中…";
    registerMsg.className = "form-msg";
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: fd.get("username"),
          email: fd.get("email"),
          password: fd.get("password"),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        registerMsg.textContent = data.error || "注册失败";
        registerMsg.className = "form-msg err";
        return;
      }
      setAuthUI(data.user);
      closeAuth();
      if (currentViewIsMember()) renderMember(data.user);
    } catch (err) {
      registerMsg.textContent = "网络错误，请重试";
      registerMsg.className = "form-msg err";
    }
  }

  async function handleLogout() {
    try {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    } catch (e) {}
    setAuthUI(null);
    if (currentViewIsMember()) renderMember(null);
  }

  function currentViewIsMember() {
    return views.member && views.member.classList.contains("active");
  }

  async function renderMember(user) {
    if (!memberArea) return;
    if (!user) {
      memberArea.innerHTML = `
        <div class="member-gate">
          <p>这是会员专属区域。登录后即可发表文章、查看会员内容。</p>
          <button class="btn-auth" type="button" id="memberLogin">🔐 登录 / 注册</button>
        </div>`;
      const b = document.getElementById("memberLogin");
      if (b) b.addEventListener("click", () => openAuth("login"));
      return;
    }
    memberArea.innerHTML = `
      <div class="member-welcome">
        <div class="member-card">
          <div class="member-avatar">${user.username.slice(0, 1).toUpperCase()}</div>
          <div>
            <h3>欢迎，${user.username} 👋</h3>
            <p class="member-sub">你已登录会员专区。</p>
          </div>
        </div>
        <div class="member-perks">
          <div class="perk">✍️ 撰写并发布文章</div>
          <div class="perk">📚 会员专享读书笔记合集</div>
          <div class="perk">💬 文章下方专属评论区</div>
          <div class="perk">🔖 收藏你喜欢的文章</div>
        </div>
        <button class="btn-publish" type="button" id="memberPublish">✍️ 现在写一篇文章</button>
        <p class="member-note">更多会员功能正在陆续开放，敬请期待。</p>
      </div>`;
    const pb = document.getElementById("memberPublish");
    if (pb) pb.addEventListener("click", openCompose);
  }

  if (authBtn) authBtn.addEventListener("click", () => openAuth("login"));
  if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);
  if (authClose) authClose.addEventListener("click", closeAuth);
  if (authModal)
    authModal.addEventListener("click", (e) => {
      if (e.target === authModal) closeAuth();
    });
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => switchTab(t.dataset.tab))
  );
  if (loginForm) loginForm.addEventListener("submit", handleLogin);
  if (registerForm) registerForm.addEventListener("submit", handleRegister);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && authModal && !authModal.hidden) closeAuth();
  });

  // ===== 发表文章（会员） =====
  function openCompose() {
    if (!composeModal) return;
    composeModal.hidden = false;
    if (composeMsg) composeMsg.textContent = "";
    if (composeForm) composeForm.reset();
  }
  function closeCompose() {
    if (composeModal) composeModal.hidden = true;
    if (composeMsg) composeMsg.textContent = "";
  }

  async function handlePublish(e) {
    e.preventDefault();
    const fd = new FormData(composeForm);
    const title = (fd.get("title") || "").trim();
    const body = (fd.get("body") || "").trim();
    if (!title || !body) {
      composeMsg.textContent = "标题和正文不能为空";
      composeMsg.className = "form-msg err";
      return;
    }
    composeMsg.textContent = "发布中，请稍候…";
    composeMsg.className = "form-msg";
    if (composeSubmit) composeSubmit.disabled = true;
    try {
      const res = await fetch("/api/posts", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          tag: (fd.get("tag") || "").trim(),
          summary: (fd.get("summary") || "").trim(),
          cover: (fd.get("cover") || "").trim(),
          body,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        composeMsg.textContent = data.error || "发布失败";
        composeMsg.className = "form-msg err";
        return;
      }
      composeMsg.innerHTML = `✅ ${data.message || "已发布"}`;
      composeMsg.className = "form-msg ok";
      composeForm.reset();
      setTimeout(() => {
        closeCompose();
        loadPosts();
      }, 1500);
    } catch (err) {
      composeMsg.textContent = "网络错误，请重试";
      composeMsg.className = "form-msg err";
    } finally {
      if (composeSubmit) composeSubmit.disabled = false;
    }
  }

  if (publishBtnChip) publishBtnChip.addEventListener("click", openCompose);
  if (composeClose) composeClose.addEventListener("click", closeCompose);
  if (composeModal)
    composeModal.addEventListener("click", (e) => {
      if (e.target === composeModal) closeCompose();
    });
  if (composeForm) composeForm.addEventListener("submit", handlePublish);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && composeModal && !composeModal.hidden) closeCompose();
  });

  // 会员视图打开时渲染（先查会话）
  const memberNav = document.querySelector('.nav-link[data-view="member"]');
  if (memberNav)
    memberNav.addEventListener("click", async () => {
      const user = await checkSession();
      renderMember(user);
    });

  updateLunar();
  setInterval(updateLunar, 1000);

  checkSession();
  loadPosts();
})();