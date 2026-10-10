# Daily News 项目规划文档索引

## 本次请求与状态

| 项目 | 内容 |
| --- | --- |
| 请求 | 先本地自用和测试，保留原信源配置及 DeepSeek Flash，实施质量修复、真实更新和网页点选标注 |
| 核对日期 | 2026-10-10（Europe/London） |
| 项目根目录 | `/Users/jerryszz/Desktop/Projects/dailyNews` |
| 工作模式 | 独立 worktree，分支 `agent/local-news-quality-plan`；用户已批准计划，继续本分支实施内容修复、标注页和本地真实更新 |
| 当前代码基准 | 刷新远程后 `main=origin/main=8d3e1998f5039ba9b8d67c33e6d893c91bf4647f`；包含已合并的 PR #20、#21 |
| 对照基准 | 旧版 `8519831714b0d6c8183336c81e8190dceddf7843`；AIHOT `3343fe2b20db4be7269113752d82d3992fc52b6b`，固定版本、不自动同步 |
| 当前计划状态 | [本地新闻与质量计划](local-news-quality-plan.md) **首版本地交付，L4/L5 继续**；修复及标注页已实现，完整新增观察及人工验收未完成 |
| 当前本地快照 | 2026-10-10 18:02 UTC：187 个栏目、启用 32、文章 267（266 历史 + 1 正常新增），264 条可公开读取；20 个空白任务；版本和证据见 [运行记录](../local-news-quality-runtime.md) |
| 原重构状态 | P1–P5 及提速代码已合并；[提速记录](../news-refresh-performance.md)有离线证据，P5 真实质量与端到端性能仍待验收；云上线按用户最新决定暂停 |

本目录保存目标、设计与验收基线。当前实现以对应提交的代码为准，不能把计划、历史 CI 或已合并状态当作已部署、已提速的证据。

## 优先阅读

1. **[本地新闻恢复、质量修复与点选标注计划](local-news-quality-plan.md)**：本次审核入口。包含原信源数量、Flash 接入、错误修复、点选页面流程、真实更新与人工验收。
2. [新闻更新提速计划](news-refresh-performance-plan.md)：核心实现已合并；三套入口、分阶段队列、批次精选、离线性能与未完成的端到端测量。
3. [基于 AIHOT 的重构计划](aihot-v2-refactor-plan.md)：已批准的产品/架构基线。十个主分类、AI 与非 AI 双策略、统一公开门槛和新旧数据库隔离继续适用。
4. [实施记录](../refactor-runtime.md)、[P5 试运行记录](../p5-bounded-trial.md)：2026-10-03 的历史证据；旧 PR 状态、端口、采集配额和价格窗不是本次个人运行配置。
5. [新版部署方案](news-deployment-plan.md)：**云部署已暂停**；保留可复用方案，不作为本地修复和试用的前置条件。

当前规范 checkout 已包含 AIHOT web/api/worker、PostgreSQL、来源适配、十类与双策略、publication 和有界试运行能力。旧 `src/`、`scripts/news*.ts`、`api/` 等保留为兼容/迁移参照。本地运行实施分支的新增标注及质量修复，32 个栏目真实采集成功；网页/API 健康不等于新闻质量已验收。服务是否仍运行以健康接口和当前进程为准，本轮未重新核对公网部署。

P5 历史记录包含 14 个栏目、31 条正常新增与 20 条历史资料，以及一次 24 条日报生成；100 条新增目标和 200 条人工标注未达到。新计划承接提取及文字生成问题；旧 cohort 保持关闭，新的本地测试不复用旧样本限额作为日常运行上限。

## 文档集合与权威边界

| 文档 | 定位与本次处理 |
| --- | --- |
| [local-news-quality-plan.md](local-news-quality-plan.md) | 已批准；修复及点选页落地，真实更新首轮通过，完整观察及用户标注继续 |
| [news-refresh-performance-plan.md](news-refresh-performance-plan.md) | 已批准；核心实现与离线回归完成，完整端到端性能与部署待验收 |
| [news-deployment-plan.md](news-deployment-plan.md) | 更新为暂停的云方案；以后恢复云部署时再核对平台、价格和接入 |
| [aihot-v2-refactor-plan.md](aihot-v2-refactor-plan.md) | 已批准基线；更新当前主干和后续本地计划入口，历史试运行设计保留 |
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

根 README 与 [架构](../architecture.md)、[运行手册](../runbook.md) 的通用架构继续保留；本轮新增路由、迁移和本地操作集中记录在 [本地实施与使用记录](../local-news-quality-runtime.md)，不重写其他历史方案。

## 本次证据与检查

- 产品提交 `4979314`：视频/侧栏及 RSS 推荐清理、中文证据检查、原规则保留、标注完整流程、来源配置校验、正常新增边界及首导队列优先级。
- 全新独立数据库 696 个后端测试、39 个网页测试、类型检查、生产构建与 31 项本地 smoke 通过，证据见运行记录。
- 两轮真实采集和 DeepSeek Flash 请求有本地记录；备份采用一致性快照，恢复到独立数据库后计数与约束匹配。
- Chrome 验证保存、修改、刷新、跳过、稍后、三种下载及重启恢复；390 px 宽度无横向溢出。临时自动答案移出交付批次，20 个任务等待用户判断。
- 详细证据、使用入口、运行目录及剩余来源依赖见 [运行记录](../local-news-quality-runtime.md)。

## 当前待确认

承载平台、已有 Key、Flash 与个人模型费用授权已明确。后续继续适配原普通网页来源；67 个原启用 X 栏目需要尚未接入的采集凭据。自然新增达到 100 条和经过真实北京时间 08:00 日报截止后补验证；用户通过网页逐步累计标签。云部署和旧生产观察任务继续暂停。
