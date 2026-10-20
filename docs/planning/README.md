# Daily News 项目规划文档索引

## 当前状态（2026-10-18）

工作模式：每周文档同步；项目根目录 `/Users/jerryszz/Desktop/Projects/dailyNews`。本次核对远端默认分支、合并记录、本地交付回执、服务管理脚本及只读进程/端口状态，未启动服务、访问模型或云库。

- **已合并**：`main=origin/main=bb8e722`，包含 PR #22 的本地质量修复、PR #23 的人工校准以及 PR #24 的存储减量。代码合并不代表云端发布或质量验收。
- **已暂停**：本机网页、API、worker、PostgreSQL 按 2026-10-13 用户要求停止；10 月 18 日只读复查仍停止。当前入口、证据及恢复条件见[本地运行记录](../local-news-quality-runtime.md)。此前持续观察和采集计划保留为恢复后的候选步骤，不自行继续。
- **存储**：PR #24 已交付，本地 0053 迁移与健康检查有 10 月 13 日回执；旧 Supabase 后续恢复仍待确认，依用户要求等待支持工单后处理，不启动云端维护。
- **人工校准**：代码已合并；本轮不读取或代填真实批次、不生成或启用校准规则，人工质量验收仍不能由代码与测试代替。

## 历史增量：数据库存储减量（2026-10-12）

2026-10-12：按用户批准的[数据库存储减量计划](database-storage-reduction-plan.md)实施，[完整存储清单](../database-storage-inventory.md)已补充。完整报告快照保留3天，额外保护最新报告及1个回滚版本；新版减少已完成采集中间数据、队列历史和回执大字段。分支 `agent/database-storage-reduction` 从本次核实的 `origin/main=fda2400` 开始，代码及隔离验证已通过（852 后端、42 网页、类型、构建、smoke）；PR与真实库应用分别验收。旧 Supabase 已应用首份迁移并删除525份过期报告，随后因磁盘/WAL空间耗尽中断；清理Cron暂停，后续安全迁移未应用，尚不能声称云端减容或恢复。完整备份已校验，恢复路径见计划。本轮不需要Snowflake；新版运行库、先前校准计划和人工标注保持原状。

## 历史增量：一轮人工校准（2026-10-11）

2026-10-11：用户要求补齐人工标注到分类/精选优化的闭环，按[一轮 200 条人工校准设计](news-review-calibration-plan.md)在 `agent/news-review-calibration` 实现。当前代码及隔离验证已通过（842 后端、42 网页、类型、构建、smoke及Chrome保存流程）；旧辅助答案保留，人工校准与改善尚未完成。下方 2026-10-10 内容是首版及来源恢复记录，不能替代本轮验证。

## 历史请求与状态（2026-10-10）

| 项目 | 内容 |
| --- | --- |
| 请求 | 先本地自用和测试，保留原信源配置及 DeepSeek Flash，实施质量修复、真实更新和网页点选标注 |
| 核对日期 | 2026-10-10（Europe/London） |
| 项目根目录 | `/Users/jerryszz/Desktop/Projects/dailyNews` |
| 工作模式 | 独立 worktree，分支 `agent/local-news-quality-plan`；用户已批准实施及 PR #22 修复后合并；合并状态以 GitHub 为准，服务切换须验证合并提交 |
| PR #22 实施起点 | 开始实施时刷新远程后 `main=origin/main=8d3e1998f5039ba9b8d67c33e6d893c91bf4647f`；包含已合并的 PR #20、#21 |
| 对照基准 | 旧版 `8519831714b0d6c8183336c81e8190dceddf7843`；AIHOT `3343fe2b20db4be7269113752d82d3992fc52b6b`，固定版本、不自动同步 |
| 当前计划状态 | [本地新闻与质量计划](local-news-quality-plan.md) **首版本地交付，L4/L5 继续**；修复及标注页已实现，完整新增观察及人工验收未完成 |
| 后续执行 | 用户已开始标注；继续恢复剩余可访问信源和真实更新，逐项列出凭据、访问或材料依赖，保护现有标注 |
| 当前本地快照 | 2026-10-10 18:59 UTC：187个栏目、启用84且本轮全部采集成功；619条文章（610历史+9正常），584条可读；40个标注任务中20个完成。完整状态及剩余依赖见[信源恢复状态](../source-restoration-status.md) |
| 原重构状态 | P1–P5 及提速代码已合并；[提速记录](../news-refresh-performance.md)有离线证据，P5 真实质量与端到端性能仍待验收；云上线按用户最新决定暂停 |

本目录保存目标、设计与验收基线。当前实现以对应提交的代码为准，不能把计划、历史 CI 或已合并状态当作已部署、已提速的证据。

## 优先阅读

1. **[本地新闻恢复、质量修复与点选标注计划](local-news-quality-plan.md)**：本次审核入口。包含原信源数量、Flash 接入、错误修复、点选页面流程、真实更新与人工验收。
2. [新闻更新提速计划](news-refresh-performance-plan.md)：核心实现已合并；三套入口、分阶段队列、批次精选、离线性能与未完成的端到端测量。
3. [基于 AIHOT 的重构计划](aihot-v2-refactor-plan.md)：已批准的产品/架构基线。十个主分类、AI 与非 AI 双策略、统一公开门槛和新旧数据库隔离继续适用。
4. [实施记录](../refactor-runtime.md)、[P5 试运行记录](../p5-bounded-trial.md)：2026-10-03 的历史证据；旧 PR 状态、端口、采集配额和价格窗不是本次个人运行配置。
5. [新版部署方案](news-deployment-plan.md)：**云部署已暂停**；保留可复用方案，不作为本地修复和试用的前置条件。

当前规范 checkout 已包含 AIHOT web/api/worker、PostgreSQL、来源适配、十类与双策略、publication 和有界试运行能力。旧 `src/`、`scripts/news*.ts`、`api/` 等保留为兼容/迁移参照。新增标注及质量修复已合入主干；84个栏目成功采集属于10月10日历史验收。当前服务暂停，不能把过去的网页/API健康当作当前可用或新闻质量验收；本轮未重新核对公网部署。

P5 历史记录包含 14 个栏目、31 条正常新增与 20 条历史资料，以及一次 24 条日报生成；100 条新增目标和 200 条人工标注未达到。新计划承接提取及文字生成问题；旧 cohort 保持关闭，新的本地测试不复用旧样本限额作为日常运行上限。

## 文档集合与权威边界

| 文档 | 定位与本次处理 |
| --- | --- |
| [database-storage-reduction-plan.md](database-storage-reduction-plan.md) | PR #24 已合并；本地迁移有历史验收，云库恢复待确认 |
| [news-review-calibration-plan.md](news-review-calibration-plan.md) | PR #23 已合并；人工标签、评测和显式启用边界继续保留 |
| [local-news-quality-plan.md](local-news-quality-plan.md) | 修复及点选页已合入；历史首轮更新通过，后续观察随服务暂停 |
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

## 首次交付证据与检查（18:02 UTC历史）

- 产品提交 `4979314`：视频/侧栏及 RSS 推荐清理、中文证据检查、原规则保留、标注完整流程、来源配置校验、正常新增边界及首导队列优先级。
- 全新独立数据库 696 个后端测试、39 个网页测试、类型检查、生产构建与 31 项本地 smoke 通过，证据见运行记录。
- 两轮真实采集和 DeepSeek Flash 请求有本地记录；备份采用一致性快照，恢复到独立数据库后计数与约束匹配。
- Chrome 验证保存、修改、刷新、跳过、稍后、三种下载及重启恢复；390 px 宽度无横向溢出。临时自动答案移出交付批次，20 个任务等待用户判断。
- 详细证据、使用入口、运行目录及剩余来源依赖见 [运行记录](../local-news-quality-runtime.md)。

## 历史后续事项（2026-10-10；恢复前不执行）

承载平台、已有Key、Flash与个人模型费用授权已明确。本轮已恢复84个栏目；剩余67个X缺凭据、13个访问失败、9个材料/入口限制分别列在[恢复状态](../source-restoration-status.md)，另14个原禁用项保持。自然新增达到 100 条和经过真实北京时间 08:00 日报截止后补验证；用户通过网页逐步累计辅助标签；正式质量验收另需实现独立盲标并完成至少 200 条有效文章标签（AI 相关至少 50 条），当前指标明确为未就绪。云部署和旧生产观察任务继续暂停。

后续验证：84源完整真实刷新通过；本轮产品提交`73fe378`，新空库后端818项、新增日期门槛相关4项、39网页测试、类型检查、构建、31项smoke通过。首批20个人工任务已完成，现有答案和第二批任务保持不变；当时最终 CI 对应 PR #22 的提交，不代表本周文档 PR 的检查结果。已有 review 修复补上独立 AI 相关性判断，并将盲标留出集设为正式验收的必需条件；现有人工答案不变。

## 本周文档验证与待确认

更新根 README、项目 AGENTS 入口、本索引、存储减量状态、本地运行说明和信源历史快照边界；没有新增产品功能或修改数据。最小检查为 `git diff --check` 与 `python3 /Users/jerryszz/.agents/skills/plan-project-docs/scripts/audit_planning_docs.py --root <工作树>`，只验证文档索引及本地链接，不重跑需数据库/模型的产品测试。

待确认：用户何时恢复本机服务、人工校准/正式质量验收，以及支持工单后的旧云库恢复；本轮没有相关新结论。既有源码、运行数据、备份、人工答案和其他工作树保持原状。
