# Daily News

Daily News 按十个领域整理公开新闻，提供中文标题、摘要、来源与原文链接。

本分支正在实施已批准的重构计划：采用固定版本 AIHOT 的网页、API、worker 与 PostgreSQL 底座。AI 分类保留原版 AI 评判，其他九类迁入 Daily News 确定性编辑规则。阶段状态和实际检查见 [实施记录](docs/refactor-runtime.md)，完整需求见 [已批准计划](docs/planning/aihot-v2-refactor-plan.md)。当前不是生产切换。更新提速的实现、测量与运行限制见 [性能记录](docs/news-refresh-performance.md)；新平台选择见 [部署方案](docs/planning/news-deployment-plan.md)。

## 本地离线启动

需要 Node.js 24.11+，以及 Docker Compose；不用 Docker 时可使用独立 PostgreSQL 17，见 [运行说明](docs/refactor-runtime.md)。

```bash
npm ci
node scripts/init-env.ts
docker compose up -d --build
```

默认地址为 `http://127.0.0.1:3300`。采集、模型、飞书与 IndexNow 均默认关闭，示范信源不自动导入。管理员密码只保存在权限为 0600 的 `.env` 中；不要把它提交到仓库或贴到日志。

```bash
npm run typecheck
npm run build
npm run test:web
# 先在名字以 _test 或 _ci 结尾的独立空库迁移，再运行后端测试：
DATABASE_URL=postgres://localhost/dailynews_test node scripts/migrate.ts
DATABASE_URL=postgres://localhost/dailynews_test npm test
```

旧系统的源码、配置与静态备份继续保留。旧运行命令见 [历史 README](docs/legacy-readme.md)；旧数据不是新公开池的当前新闻，不会在离线启动时伪装成实时内容。

代码来自固定上游，保留 [MIT 许可证](LICENSE)、[第三方声明](NOTICE) 和 [基准清单](reference/baselines/README.md)。
