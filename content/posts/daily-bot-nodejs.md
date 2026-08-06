---
title: 用 Node.js + GitHub Actions 打造每日定时推送机器人
date: 2026-08-05
tag: 自动化
summary: 记录 daily-bot 项目的实现思路：定时任务、消息推送与零成本托管。
---

在日常开发中，总会有些重复的事想让它自己跑——比如每天早上给我推送一条天气、一条待办、一条随机金句。`daily-bot` 就是为此而生的小项目。

## 为什么是 Node.js + GitHub Actions

GitHub Actions 提供免费的定时运行环境（cron），配合 Node.js 写业务逻辑，几乎零成本，也不需要一个常驻服务器。

- 用 `cron` 表达式设定每天 08:00 触发
- Action 拉取代码、装依赖、运行脚本
- 脚本调用推送接口（如企业微信/飞书/邮件）把内容发出去

## 核心片段

```yaml
on:
  schedule:
    - cron: '0 0 * * *'   # UTC 0 点 ≈ 北京 08:00
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
