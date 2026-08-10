-- 由 scripts/migrate-to-d1.mjs 自动生成
-- 共 5 篇文章

-- 来源：2026-08-09-君子睽散于义理，小人睽散于利益.md
INSERT OR REPLACE INTO posts (slug, title, date, tag, summary, cover, author_username, body) VALUES ('君子睽散于义理-小人睽散于利益', '君子睽散于义理，小人睽散于利益', '2026-08-10', '倪师', '君子同于义理，小人不以义理为准却以自身利益为准。', NULL, '昉昕', '## ***君子同于义理，小人不以义理为准却以自身利益为准。***
');

-- 来源：cloudflare-pages-static.md
INSERT OR REPLACE INTO posts (slug, title, date, tag, summary, cover, author_username, body) VALUES ('cloudflare-pages-static', '把静态网站托管到 Cloudflare Pages 的几种姿势', '2026-07-28', '部署', '从 Git 自动部署到 CLI 上传，聊聊 Cloudflare Pages 的便利与坑。', NULL, '昉昕', 'Cloudflare Pages 对静态站和前端框架极其友好：全球 CDN、自动 HTTPS、免费额度也很慷慨。

## 方式一：Git 连接（推荐）

在控制台连接 GitHub 仓库，设定构建命令与输出目录，之后每次 push 都会自动部署并生成预览链接。

## 方式二：wrangler CLI

不想连 Git 时，可以本地直接上传：

```bash
npx wrangler pages deploy ./blog-site --project-name=my-blog
```

记住构建产物目录要和命令里的路径一致，否则会部署一个空站。
');

-- 来源：daily-bot-nodejs.md
INSERT OR REPLACE INTO posts (slug, title, date, tag, summary, cover, author_username, body) VALUES ('daily-bot-nodejs', '用 Node.js + GitHub Actions 打造每日定时推送机器人', '2026-08-05', '自动化', '记录 daily-bot 项目的实现思路：定时任务、消息推送与零成本托管。', NULL, '昉昕', '在日常开发中，总会有些重复的事想让它自己跑——比如每天早上给我推送一条天气、一条待办、一条随机金句。`daily-bot` 就是为此而生的小项目。

## 为什么是 Node.js + GitHub Actions

GitHub Actions 提供免费的定时运行环境（cron），配合 Node.js 写业务逻辑，几乎零成本，也不需要一个常驻服务器。

- 用 `cron` 表达式设定每天 08:00 触发
- Action 拉取代码、装依赖、运行脚本
- 脚本调用推送接口（如企业微信/飞书/邮件）把内容发出去

## 核心片段

```yaml
on:
  schedule:
    - cron: ''0 0 * * *''   # UTC 0 点 ≈ 北京 08:00
jobs:
  push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm start
```

把密钥放在仓库的 `Secrets` 里，脚本通过环境变量读取，安全又省心。
');

-- 来源：js-closure-again.md
INSERT OR REPLACE INTO posts (slug, title, date, tag, summary, cover, author_username, body) VALUES ('js-closure-again', '再聊 JavaScript 闭包：不只是面试题', '2026-06-30', '前端', '从一次真实的内存泄漏排查，重新理解闭包的生命周期。', NULL, '昉昕', '闭包常被当成面试题，但它真实影响着内存与性能。一次排查中发现：某个事件回调长期持有大对象引用，导致页面越用越卡。

## 关键点

闭包会让外部作用域的变量「多活一会儿」。如果那个变量很大，而回调又一直没释放，内存就悄悄涨上去了。

```js
function createHandler(bigData) {
  return () => console.log(bigData.length); // bigData 被一直引用
}
```

解决办法是在不需要时主动置空，或把大对象改成按需读取。
');

-- 来源：reading-notes-deep-work.md
INSERT OR REPLACE INTO posts (slug, title, date, tag, summary, cover, author_username, body) VALUES ('reading-notes-deep-work', '读书笔记：《深度工作》里最击中我的一句话', '2026-07-15', '读书', '注意力是这个时代最稀缺的资源，而我们把太多给了浅层事务。', NULL, '昉昕', '卡尔·纽波特的《深度工作》核心很简单：能长时间无干扰专注的人，会比频繁切换的人创造高出数量级的价值。

## 我的实践

- 每天上午留出 2 小时「免打扰」时段
- 把刷信息流移到午休和傍晚
- 用待办清单把琐事一次性批量处理

坚持一个月后，最明显的改变不是产出更多，而是下班时脑子更清醒了。
');

