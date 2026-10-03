# Daily News 项目规划文档索引

## 本次请求与状态

| 项目 | 内容 |
| --- | --- |
| 请求 | 执行已批准的 AIHOT 重构计划 P1–P5，分阶段实现与本地有界验证 |
| 更新时间 | 2026-10-03（Asia/Shanghai） |
| 项目根目录 | `/Users/jerryszz/Desktop/Projects/dailyNews` |
| 工作模式 | 实施模式；独立 `agent/aihot-p1-baseline` worktree；规范目录与旧服务保留 |
| 现行代码基准 | 交接 `ce3f9263c3901839a85794aecea8bc55e67bf0e4`；旧规则固定 `8519831714b0d6c8183336c81e8190dceddf7843` |
| AIHOT 目标基准 | `3343fe2b20db4be7269113752d82d3992fc52b6b`；固定版本，不自动同步上游 |
| 新计划状态 | P0 已批准；P1 本地离线已验证，PR/CI 待交付；P2–P5 待实施，未生产切换 |

本目录保存需求、方案与历史记录；当前已实现行为以对应分支代码以及 [现有架构](../architecture.md)、[运行手册](../runbook.md) 为准。新计划不会因为写入文档或建立 PR 就自动成为已实现事实。

## 优先阅读

**[Daily News 基于 AIHOT 的重构计划](aihot-v2-refactor-plan.md)** 是本次实施基线，包含：

- AI 分类沿用 AIHOT 默认评判，其他九类保留 Daily News 现行规则；
- 先分类、后策略路由，事件级判断与公开读取的适配；
- 全部新闻采用 AIHOT 公开门槛；
- 逐类采集迁移、原来源与禁用状态、独立数据库、历史/API 兼容与回滚；
- DeepSeek 有界试运行、成本与质量记录、阶段任务和验收条件。

规范 checkout/旧产品仍是 Vite + React + TypeScript 事件级简报，包含十类导航、事件归并、公共重要性、热点和冻结日报；现有生产形态由代码定义为 Supabase 持久状态与受保护刷新入口。后台的实际部署、Cron、数据量和健康状态本次未验证。

实施分支已导入固定 AIHOT 的 web/api/worker 和 PostgreSQL 底座，离线运行已验证；双策略、来源迁移和产品适配仍待后续阶段。详见 [实施记录](../refactor-runtime.md)。

## 文档集合与权威边界

| 文档 | 定位与本次处理 |
| --- | --- |
| [aihot-v2-refactor-plan.md](aihot-v2-refactor-plan.md) | 已批准实施方案，集中描述产品、架构、数据、接口、试运行、实施和验收 |
| [news-curation-refactor-plan.md](news-curation-refactor-plan.md) | 原管线设计与历史实施记录；新增适用范围说明，避免与未来全部新闻定义冲突 |
| [source-collection-scaling-plan.md](source-collection-scaling-plan.md) | 原管线信源扩充与有界采集方案；保留作为来源迁移依据，并补入索引 |
| [prd.md](prd.md) | 原产品需求与行为基线；重构版目标优先读新计划，实施时再同步 |
| [technical-design.md](technical-design.md) | 原模块与契约设计，不代表未来 AIHOT 实现已存在 |
| [database-design.md](database-design.md) | 原 Supabase/候选/快照方案；未来新库与迁移边界写在新计划中 |
| [api-design.md](api-design.md) | 原 HTTP API 契约；新 API 与旧接口过渡在新计划中定义 |
| [security-privacy.md](security-privacy.md) | 原权限、凭据及网络边界；仍用于来源适配的保留要求 |
| [test-plan.md](test-plan.md) | 原系统验证方案；新计划单独列出未来需要运行的基准与迁移检查 |
| [release-plan.md](release-plan.md) | 原部署流程；新系统生产切换与回滚另见新计划，当前没有发布动作 |
| [production-acceptance-2026-07-13.md](production-acceptance-2026-07-13.md) | 2026-07 的历史验收记录；不证明当前健康、监控存活或部署版本 |

既有 planning 文件中带日期的数量、性能和完成状态仅在原记录范围内解释。此次不把整个旧文档集重写成未来方案；重构实施时按阶段同步对应文档，保留历史与已实现事实的区别。

## 本次核对的关键证据

| 证据 | 用途 |
| --- | --- |
| `AGENTS.md`、Git status/worktree、刷新后的 `origin/main` | 文档范围、版本基线、现有工作保护与用户确认边界 |
| `src/types.ts`、`src/App.tsx`、`src/config/sources.ts`、`expandedSources.ts`、`xAccounts.ts` | 十类、来源栏目、偏好和现有入口 |
| `src/lib/curation.ts`、`scoring.ts`、`newsOrdering.ts`、`dedupe.ts`、`trust.ts` | 区分当前事件编辑算法与兼容排序；确定非 AI 保留范围 |
| `scripts/newsService.ts`、`newsRefresh.ts`、`xSource.ts` | 来源适配、处理阶段、状态与增量游标 |
| `docs/architecture.md`、`docs/runbook.md`、现有 planning | 当前/历史/未来边界；禁止恢复已取消的正式 burn-in/soak |
| 固定 AIHOT 的 `industry/`、`editorial/`、`publication/`、`events/`、`reports/`、worker 与 CI | 默认评分、分类顺序、公开门槛、队列、预算、迁移与验证命令；不可等同于运行验证 |

## 本次检查

P1 的类型、构建、迁移、后端 566 项 + 新增安全测试 2 项、网页 31 项、smoke 30 项及 Chrome 空页面已验证；详见 [实施记录](../refactor-runtime.md)。planning audit 与 whitespace 检查随 PR 执行。

以下是文档 PR #14 的历史检查范围。实施阶段结果逐阶段记录，尚未执行的检查不计为通过。已核验 main 交接 SHA、AIHOT 固定 SHA 和规范目录干净状态；未检查生产健康。

文档交付前执行 planning 索引/本地链接检查，以及 `git diff --check`；检查结果在本次交付记录/PR 中报告。本地未重跑产品单元、集成、数据库、构建或真实采集测试，因为这次只改规划文档；PR 可能触发现有 CI，其结果以对应提交检查为准，不能作为新框架已经运行的证据。

AIHOT 的未来测试、有限真实试运行和质量指标在 [新计划的验证章节](aihot-v2-refactor-plan.md#11-验证与验收) 中，不能把计划命令视为已通过的检查。

## 待确认与后续入口

| 事项 | 状态 |
| --- | --- |
| 整份重构计划及其细化建议 | 2026-10-03 用户明确批准；执行 P1–P5 |
| AI/非 AI 评判分工、全部新闻定义、DeepSeek 优先、固定上游版本 | 用户已确定；不重新当作开放问题 |
| 统一热点、混合日报编排、本地独立 PostgreSQL、旧日报归档、试运行参数 | 已随计划批准；记录实测差异 |
| 实际 DeepSeek 模型、凭据可用性、token 单价和费用 | 试运行前核实；本次未读取凭据或发出付费请求 |
| 生产服务器、域名、长期预算与生产切换 | 本地结果出来后再确定；批准计划不等于立即生产切换 |
| 历史数据体量、旧 API 调用者、长期保留策略 | P1 盘点，切换前形成数据清单与兼容/归档方案 |

修改现行系统仍按原代码契约与仓库规则交付。执行重构则先读新计划，按阶段补测试、同步文档、提交 PR；不得用“采用模板”省略来源映射、规则对照、数据读回或最终页面验证。

## 文档维护范围

- 不拆出第二套 PRD、数据库、API、发布和测试文档：集中维护已批准基线；实现阶段按实际差异更新。
- 不新增 project brief、user flow、decision log：目标、流程和关键决策已在新计划内。
- 实施时同步根 README、`docs/architecture.md`、`docs/runbook.md` 及对应设计/测试文档；明确旧系统与特性分支的实际状态。
- 不追加历史生产验收窗口，不创建监控/heartbeat。正式 24 小时 burn-in 与七天 soak 已取消；未来有限试运行也不复用旧窗口。

线上状态须通过对应部署、真实页面/API 和运行数据验证。`.production-acceptance/current/summary.json` 仅为历史记录；如需判断旧 observer 是否存活，必须运行项目规定的 status 命令并核对部署，但本次没有启动或检查它。
