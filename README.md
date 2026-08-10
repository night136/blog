# 昉昕的博客

简洁现代的静态博客 + 会员系统，统一部署到 Cloudflare Pages。

- **前台**：轮播、卡片、分类筛选、农历时辰、骨架屏、响应式
- **会员**：访客账号密码注册/登录，会员可在站内**直接发表文章**
- **数据**：文章与会员资料均存储在 Cloudflare **D1 SQLite**（数据库随 Cloudflare 账户走，无需第三方）

## 目录结构

```
blog-site/
├── index.html              # 博客前台（单页应用）
├── assets/
│   ├── style.css           # 样式
│   ├── app.js              # 前端逻辑：fetch /api/posts
│   └── vendor/lunar.js     # 农历计算库
├── content/posts/          # 文章源 md（迁移前的内容备份，可留可删）
│   ├── *.md
│   └── index.json
├── functions/api/          # Cloudflare Pages Functions
│   ├── _lib/auth.js        # PBKDF2 密码 + HS256 JWT + Cookie
│   ├── register.js         # POST 注册
│   ├── login.js            # POST 登录
│   ├── logout.js           # POST 登出
│   ├── me.js               # GET 当前会话
│   ├── posts.js            # GET 列表 / POST 创建
│   └── posts/[slug].js     # GET 单篇 / DELETE 删除
├── scripts/
│   ├── schema.sql          # D1 表结构
│   ├── migrate-to-d1.mjs   # 把现有 md 转换为 INSERT 语句
│   └── migrate-data.sql    # 上述脚本生成的 SQL（可直接贴 D1 控制台执行）
└── README.md
```

## 本地预览

```bash
cd blog-site
python3 -m http.server 8080
# 打开 http://localhost:8080
```

注意：本地预览时 `/api/posts` 等接口不会响应，因为 Functions 仅在 Cloudflare Pages 上运行。

## 部署到 Cloudflare Pages

1. **建 D1 数据库**：左侧 Workers & Pages → **D1 SQL Database** → **Create** → 命名如 `blog-data`
2. **删旧 Worker 项目**（如果存在）：Worker 项目不能跑 Functions，只能 Pages 能
3. **新建 Pages 项目**：Workers & Pages → **Create** → **Pages** → **Connect to Git**
   - 仓库：`night136/blog`
   - **Build command**：留空（纯静态）
   - **Build output directory**：`/`（项目根）
4. **绑定 D1**：Pages 项目 → Settings → **Functions** → **D1 SQL Database bindings** → Add binding
   - Variable name: `BLOG_DB`（一字不差）
   - D1 database: 选刚才的 `blog-data`
5. **加 secret**：Settings → **Environment variables** → Add variable
   - `JWT_SECRET` = 一段随机字符（用于 JWT 签名）
6. **建表 + 迁移数据**：
   - 左侧 Workers & Pages → D1 → 你的数据库 → **Console** 标签
   - 粘贴 `scripts/schema.sql` 内容 → 点 **Execute**
   - 粘贴 `scripts/migrate-data.sql` 内容 → 点 **Execute**（导入现有 5 篇文章）
7. **重新部署**：Pages 项目 → Deployments → Retry deployment

## 日常使用

- **访客发文章**：登录会员 → 首页点 ✍️ 发文章 → 填标题正文 → 发布 → 立即可见
- **作者登录**：账号密码登录即可（已注册的账号）

## 安全提醒

- `JWT_SECRET` 必须设置长随机串（不能用默认 dev-secret）
- 删除不再使用的 GitHub OAuth Worker 与 Decap CMS 相关代码（已清理）