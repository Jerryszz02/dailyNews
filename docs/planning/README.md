# Daily News 项目规划文档索引

## 本次请求与状态

| 项目 | 内容 |
| --- | --- |
| 请求 | 修复 PR #20 review 并合并；按最新主干实施提速，验证后部署；用户确认仅有 Vercel，需要选择新版托管方案 |
| 核对日期 | 2026-10-10（Europe/London） |
| 项目根目录 | `/Users/jerryszz/Desktop/Projects/dailyNews` |
| 工作模式 | 独立 worktree，分支 `agent/news-refresh-speed`；先记录基准，再实现与验证 |
| 当前代码基准 | 刷新远程后 `main=origin/main=3af1848803bb4e034521e7c1c54fd4e21232c5e4`；PR #20 review 已修复、CI 通过并合并 |
| 对照基准 | 旧版 `8519831714b0d6c8183336c81e8190dceddf7843`；AIHOT `3343fe2b20db4be7269113752d82d3992fc52b6b`，固定版本、不自动同步 |
| 当前计划状态 | [新闻更新提速计划](news-refresh-performance-plan.md) **核心实现与离线验证完成**；[实测记录](../news-refresh-performance.md)，端到端性能及部署未验收 |
| 原重构状态 | P1–P5 代码已合并；P5 有界真实试运行属于历史记录，质量门槛仍未通过；本次未验证生产部署 |

本目录保存目标、设计与验收基线。当前实现以对应提交的代码为准，不能把计划、历史 CI 或已合并状态当作已部署、已提速的证据。

## 优先阅读

1. **[新闻更新提速计划](news-refresh-performance-plan.md)**：本次审核入口。包含三套入口的差异、阶段耗时与处理数、提前识别无变化内容、持久队列交接、批次精选、回归与前后开销对照、迁移和回滚。
2. **[基于 AIHOT 的重构计划](aihot-v2-refactor-plan.md)**：已批准的产品/架构基线。保留十个主分类；AI 沿用 AIHOT 评判、其他九类沿用 Daily News 规则；全部动态使用统一公开门槛；新 PostgreSQL 与旧库隔离。
3. [实施记录](../refactor-runtime.md)、[P5 试运行记录](../p5-bounded-trial.md)：查看 2026-10-03 的历史实现与验证证据。实施记录中 PR 待合并、当时预览端口等文字是历史快照；当前合并状态以本次 Git/GitHub 核对为准，服务存活需重新检查。
4. [新版部署方案](news-deployment-plan.md)：用户确认只有 Vercel 后的部署选择；包含运行布局、费用口径、账户接入和切换步骤，尚未上线。

当前规范 checkout 已包含 AIHOT web/api/worker、PostgreSQL、来源适配、十类与双策略、publication 和有界试运行能力。旧 `src/`、`scripts/news*.ts`、`api/` 等保留为兼容/迁移参照，不能继续把规范目录描述为仅运行旧 Vite 系统。实际访问的生产版本、worker、Cron、来源成功水位和健康状态本次未验证。

P5 历史记录包含 14 个来源、31 条正常新增与 20 条历史资料，以及一次 24 条日报生成；100 条新增目标和 200 条人工金标准未达到，提取与文字生成质量仍有未解决问题。性能计划不扩充来源，也不把这些质量问题计为已解决。

## 文档集合与权威边界

| 文档 | 定位与本次处理 |
| --- | --- |
| [news-refresh-performance-plan.md](news-refresh-performance-plan.md) | 已批准；核心实现与离线回归完成，完整端到端性能与部署待验收 |
| [news-deployment-plan.md](news-deployment-plan.md) | 新增；常驻运行环境、基础设施预算和部署切换方案，平台待选择 |
| [aihot-v2-refactor-plan.md](aihot-v2-refactor-plan.md) | 已批准基线；本次只同步 P1–P5 合并状态并链接补充方案 |
| [news-curation-refactor-plan.md](news-curation-refactor-plan.md) | 原管线设计与历史实施记录，保留为非 AI 策略依据 |
| [source-collection-scaling-plan.md](source-collection-scaling-plan.md) | 原信源扩充与有界采集设计，保留为来源迁移依据；本轮不扩源 |
| [prd.md](prd.md) | 原产品需求基线；跨行业重构目标以 AIHOT 重构计划为准 |
| [technical-design.md](technical-design.md) | 原模块与契约设计；本轮技术方案集中在提速计划 |
| [database-design.md](database-design.md) | 原 Supabase 方案；新版数据库设计/迁移以代码及两份新计划为准 |
| [api-design.md](api-design.md) | 原 HTTP 契约；新版公开接口见 [版本化契约](../../reference/public-v1.openapi.json) 与 [接口过渡](../legacy-api-transition.md) |
| [security-privacy.md](security-privacy.md) | 原权限与网络边界；继续保留，不新增遥测服务或凭据流程 |
| [test-plan.md](test-plan.md) | 原系统验证方案；提速实验、等价性和故障恢复验收集中在补充计划 |
| [release-plan.md](release-plan.md) | 原发布流程；新版切换与本次增量迁移/回滚分别见两份新计划 |
| [production-acceptance-2026-07-13.md](production-acceptance-2026-07-13.md) | 2026-07 历史验收，不证明当前健康、监控或部署版本 |

根 README 与 [架构](../architecture.md)、[运行手册](../runbook.md) 是仓库说明；读取时须区分旧实现和新增入口。本次增加 [更新提速运行记录](../news-refresh-performance.md)，同步根 README/架构/运行手册入口。旧运行手册仍保留历史实现边界。

## 本次证据与检查

- PR #20 的既有 review 已修复并回复/解决，确切 head CI 通过后合并为 `3af1848`；没有手动请求新一轮 review。
- 当前 Vercel 最近生产提交经 API 读回为旧版 `8912036`。用户确认只有 Vercel；平台与新增预算待选择，未切换生产。
- 独立新库全部 47 个迁移及后端 658/658、网页 35/35、完整类型检查、生产构建通过；web/API/worker smoke 31 项、MCP 与 heartbeat 通过。临时应用进程已停止。
- 基准每组 1 次预热、5 次计量，记录全新路径、980 未变化/10 新增/10 修改及 100 篇批次发布；[结果和限制](../news-refresh-performance.md) 与 [原始数据](../benchmarks/news-refresh-2026-10-10.json) 可复核。
- 不将微基准当作生产 P95，不将 CI 当作已部署，也未扩源、扩大模型预算或恢复历史观察任务。
- planning 本地链接 audit、`git diff --check` 和对应 PR 的 CI 结果在交付中分别报告。
