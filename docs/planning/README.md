# Daily News 项目规划文档索引

## 文档目的

这组文档根据当前仓库可见内容整理，用于让第一次接触 Daily News 的开发者理解项目是什么、如何运行、主要行为边界在哪里，以及后续修改应优先参考哪些约束。仅根据当前仓库可见内容整理；未在仓库中找到证据的内容均不做假设。

## 生成信息

| 项目 | 内容 |
| --- | --- |
| 请求 | 在现有项目文档基础上，规划新闻来源与选题系统的完整重构 |
| 更新时间 | 2026-07-10 |
| 项目根目录 | `/Users/jerryszz/Desktop/Projects/dailyNews` |
| 工作模式 | 核心实现已落地；运营验证与生产持久化待完成 |

## 项目概览

Daily News 是一个 Vite + React + TypeScript 事件级新闻日报。它从配置化来源发现候选，经过质量门槛、事件聚类、证据状态、公共影响分级和集合级多样性选择，在网页中展示今日必知、重要进展、持续关注、分类深读、搜索和偏好设置。

事件级核心管线、V2 API/UI、last-known-good 和 30 秒采集预算已实现。继续开发前先读 [news-curation-refactor-plan.md](news-curation-refactor-plan.md) 的实施状态；7–14 天 golden dataset、连续 7 天 shadow、外部生产存储和历史日报仍未完成。

项目由四条主要链路组成：

| 链路 | 作用 | 主要入口 |
| --- | --- | --- |
| 来源配置 | 定义新闻来源、栏目、查询词、主分类、语言、地区、可信度、付费墙提示和启用状态 | `src/config/sources.ts` |
| 报告生成 | 覆盖调度、Firecrawl/直连候选、质量门槛、事件证据、公共影响分层、30 秒预算和 fallback | `src/lib/sourceCoverage.ts`, `src/lib/curation.ts`, `scripts/newsService.ts` |
| API 与静态服务 | 启动即读取 last-known-good，读请求不抓取；刷新通过相对质量门槛才切换 latest | `scripts/reportStore.ts`, `scripts/newsApi.ts`, `scripts/newsServer.ts` |
| 前端体验 | 优先读取 V2 API，再读静态 V2/V1 自动升级，展示三个首页层级和统一事件分类引用 | `src/App.tsx` |

## 已检查的项目证据

| 证据 | 用途 |
| --- | --- |
| `README.md` | 项目定位、运行命令、数据生成、API、中文化边界和核心文件说明 |
| `AGENTS.md` | 项目编辑规则、数据流、命令、安全边界和分类/可信度约束 |
| `docs/architecture.md` | 当前数据流、运行形态、API 路由和安全边界 |
| `docs/runbook.md` | 启动、生成、验证、环境变量和排障命令 |
| `package.json` | npm scripts、依赖和项目类型 |
| `vite.config.ts` | Vite 开发端口和 `/api` 代理配置 |
| `src/App.tsx` | 用户界面、API/static/snapshot fallback、偏好存储、搜索和展示逻辑 |
| `src/types.ts` | 核心数据类型和 `DailyNewsReport` 结构 |
| `src/config/sources.ts` | 来源、栏目、主分类、查询和可信度配置 |
| `src/lib/newsPipeline.ts` | 过滤启用来源、聚类、排序、可信度过滤和报告 notes |
| `src/lib/curation.ts`, `src/lib/sourceCoverage.ts` | V2 事件选题与来源覆盖调度 |
| `src/lib/dedupe.ts` | 同事件聚类和唯一主分类选择规则 |
| `src/lib/scoring.ts` | 排序评分维度和排序原因 |
| `src/lib/trust.ts` | 可信度评分、展示门槛和原因 |
| `src/lib/newsOrdering.ts` | 偏好列表、热点列表和分类列表排序方式 |
| `scripts/newsService.ts` | 生成链路、Firecrawl keyless、直接来源抓取、翻译配置、fallback 读取 |
| `scripts/newsApi.ts`, `scripts/reportStore.ts` | Serverless 只读 API、刷新鉴权、last-known-good 和发布门槛 |
| `scripts/newsServer.ts` | API 路由、刷新缓存、静态文件服务和健康检查 |
| `public/daily-news.json` | 当前报告的来源、分类和摘要质量基线；仅用于审计，不作为编辑源 |
| `src/lib/scoring.test.ts`, `src/lib/newsOrdering.test.ts` | 已有自动化验证覆盖点 |
| Google News、Reuters、AP 官方原则 | 用于约束显著性、权威性、新鲜度、独立性、准确性和来源归因，不代表引入外部付费 API |

## 已生成文档

| 文档 | 用途 |
| --- | --- |
| [news-curation-refactor-plan.md](news-curation-refactor-plan.md) | 定义事件级新闻来源、选题、摘要、运行架构、实施阶段和量化验收 |
| [database-design.md](database-design.md) | 定义事件、证据、来源健康、选题运行和 last-known-good 报告的逻辑持久状态 |
| [prd.md](prd.md) | 定义当前可见产品行为、用户流程、内容边界和验收要求 |
| [technical-design.md](technical-design.md) | 记录实现链路、模块职责、fallback 顺序、分类/排序/可信度契约和维护步骤 |
| [api-design.md](api-design.md) | 固化当前本地 HTTP API 的请求、响应、错误和兼容性约束 |
| [security-privacy.md](security-privacy.md) | 记录 secrets、外部抓取、浏览器边界、公开数据和剩余风险 |
| [test-plan.md](test-plan.md) | 定义行为、API、生成、前端和人工验证方式 |

## 已跳过目录文档

| 文档 | 跳过原因 |
| --- | --- |
| `project-brief.md` | 项目背景和目标可由本索引与 `prd.md` 覆盖，单独成篇会重复 README |
| `architecture.md` | 仓库已有 `docs/architecture.md`，planning 只在 `technical-design.md` 中记录需要实现者遵守的约束 |
| `user-flow.md` | 用户流程已合并进 `prd.md`，当前 UI 流程不需要独立维护文档 |
| `release-plan.md` | V1/V2 shadow、feature flag 和回滚已合并进重构计划；生产存储与发布窗口确认后再拆出独立发布文档 |
| `operations-runbook.md` | 仓库已有 `docs/runbook.md`，planning 不重复维护命令清单 |
| `decision-log.md` | 可见决策数量少，已在 `technical-design.md` 和 `security-privacy.md` 中记录关键取舍 |

## 后续开发入口

1. 修改新闻来源或选题前，先读 [news-curation-refactor-plan.md](news-curation-refactor-plan.md)，保留 V2 质量门槛、V1 `items` 兼容和 last-known-good 回滚路径。
2. 引入持久状态前读 [database-design.md](database-design.md)，保持报告不可变、latest 原子切换和 V1 回滚能力。
3. 修改当前用户可见行为前读 [prd.md](prd.md)，以事件级 V2 首页为当前行为。
4. 修改数据生成、排序、去重、可信度或 fallback 前读 [technical-design.md](technical-design.md)。
5. 修改 `/api/*` 路由或响应字段前读 [api-design.md](api-design.md)。
6. 涉及 `.env.local`、翻译密钥、Firecrawl、外部抓取或浏览器数据边界时先读 [security-privacy.md](security-privacy.md)。
7. 实现完成后按 [test-plan.md](test-plan.md) 验证 golden dataset、API 兼容和浏览器体验。

## 待确认

| 项 | 为什么无法从当前仓库确定 |
| --- | --- |
| 目标用户和正式使用场景 | 仓库说明为“原型”，没有产品 brief、访谈、运营目标或正式用户角色文档 |
| 生产发布流程 | 仓库有 Vercel 入口与配置，但本轮未执行部署、CI 或灰度发布 |
| 数据更新 SLA | 仓库说明了默认 15 分钟服务端刷新和前端每分钟检查，但没有业务级新鲜度目标 |
| 来源准入和禁用审批流程 | `src/config/sources.ts` 有启用状态和可信度字段，但没有谁能批准新增/禁用来源的流程 |
| 真实访问量、性能目标和监控 | 没有生产监控、日志聚合、告警或性能预算证据 |
| 长期数据保留策略 | 没有数据库；`public/daily-news.json` 和内存缓存之外没有持久化证据 |
| 首页最终事件数量 | 当前按质量门槛自然变化，不为达到建议区间回填低价值事件；阈值仍需 golden dataset 校准 |
| 最终 beat/栏目 | 建议把主题、地理范围和事件类型拆轴；具体一级栏目仍需确认 |
| 生产持久存储 | 事件持续更新和 last-known-good 需要持久状态，但供应商和成本边界未确认 |
| 模型使用边界 | 建议只用于结构化提取、翻译和事实约束摘要，供应商与预算待确认 |

## 人工检查建议

| 建议 | 原因 |
| --- | --- |
| 确认 Daily News 的目标读者和主要使用频率 | 当前只能从 UI 和 README 推断是个人/原型新闻日报，无法确定正式产品定位 |
| 确认是否计划部署到公开服务器 | API CORS 当前为 `*`，且服务假设本地运行；公开部署会改变安全和运维要求 |
| 确认新增来源的评估标准 | 代码有 `credibility`、`enabled`、`mayHavePaywall`，但没有来源准入流程 |
| 确认翻译服务是否固定使用本地 OpenAI-compatible 服务 | README 只给出可选变量，不能确定供应商、模型和成本边界 |
| 确认是否需要保存历史日报 | 当前没有数据库或历史归档机制；如果需要，会影响数据设计和发布计划 |
