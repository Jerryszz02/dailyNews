# Daily News 项目规划文档索引

## 文档目的

这组文档根据当前仓库可见内容整理，用于让第一次接触 Daily News 的开发者理解项目是什么、如何运行、主要行为边界在哪里，以及后续修改应优先参考哪些约束。仅根据当前仓库可见内容整理；未在仓库中找到证据的内容均不做假设。

## 生成信息

| 项目 | 内容 |
| --- | --- |
| 请求 | 用 `plan-project-docs` 为现有 Daily News 项目生成 `docs/planning/` 项目文档 |
| 更新时间 | 2026-07-01 |
| 项目根目录 | `/Users/jerryszz/Desktop/Projects/dailyNews` |
| 工作模式 | 现有项目梳理模式 |

## 项目概览

Daily News 是一个 Vite + React + TypeScript 新闻日报原型。它从配置化新闻来源抓取或读取新闻，经过去重、唯一主分类归属、排序、可信度评估后，在网页中展示偏好新闻、分类新闻、当前热点、搜索、可信度标签和偏好设置。

项目由四条主要链路组成：

| 链路 | 作用 | 主要入口 |
| --- | --- | --- |
| 来源配置 | 定义新闻来源、栏目、查询词、主分类、语言、地区、可信度、付费墙提示和启用状态 | `src/config/sources.ts` |
| 报告生成 | Firecrawl keyless 抓取，失败后直接抓公开来源，再兜底到静态/快照数据，并构建 `DailyNewsReport` | `scripts/newsService.ts`, `scripts/generateDailyNews.ts` |
| API 与静态服务 | 本地缓存新闻报告，暴露 `/api/news`、`/api/health`、`/api/refresh`，并在生产式运行时托管 `dist/` | `scripts/newsServer.ts` |
| 前端体验 | 优先读取 `/api/news`，再读 `/daily-news.json`，最后使用 `firecrawlSnapshotNews`；提供导航、搜索、热点、时间线和偏好设置 | `src/App.tsx` |

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
| `src/lib/dedupe.ts` | 同事件聚类和唯一主分类选择规则 |
| `src/lib/scoring.ts` | 排序评分维度和排序原因 |
| `src/lib/trust.ts` | 可信度评分、展示门槛和原因 |
| `src/lib/newsOrdering.ts` | 偏好列表、热点列表和分类列表排序方式 |
| `scripts/newsService.ts` | 生成链路、Firecrawl keyless、直接来源抓取、翻译配置、fallback 读取 |
| `scripts/newsServer.ts` | API 路由、刷新缓存、静态文件服务和健康检查 |
| `src/lib/scoring.test.ts`, `src/lib/newsOrdering.test.ts` | 已有自动化验证覆盖点 |

## 已生成文档

| 文档 | 用途 |
| --- | --- |
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
| `database-design.md` | 仓库证据显示没有数据库；运行时缓存为内存，静态 JSON 是生成产物 |
| `release-plan.md` | 当前证据只说明本地开发和生产式本地服务，没有生产发布、迁移、分阶段发布或回滚机制 |
| `operations-runbook.md` | 仓库已有 `docs/runbook.md`，planning 不重复维护命令清单 |
| `decision-log.md` | 可见决策数量少，已在 `technical-design.md` 和 `security-privacy.md` 中记录关键取舍 |

## 后续开发入口

1. 修改用户可见行为前先读 [prd.md](prd.md)，确认是否影响中文化、分类、偏好、搜索、热点或可信度展示。
2. 修改数据生成、排序、去重、可信度或 fallback 前先读 [technical-design.md](technical-design.md)。
3. 修改 `/api/*` 路由或响应字段前先读 [api-design.md](api-design.md)。
4. 涉及 `.env.local`、翻译密钥、Firecrawl、外部抓取或浏览器数据边界时先读 [security-privacy.md](security-privacy.md)。
5. 实现完成后按 [test-plan.md](test-plan.md) 选择最小验证命令。

## 待确认

| 项 | 为什么无法从当前仓库确定 |
| --- | --- |
| 目标用户和正式使用场景 | 仓库说明为“原型”，没有产品 brief、访谈、运营目标或正式用户角色文档 |
| 生产部署方式 | 只有本地 dev、generate、serve 命令；没有托管平台、域名、CI/CD 或发布配置证据 |
| 数据更新 SLA | 仓库说明了默认 15 分钟服务端刷新和前端每分钟检查，但没有业务级新鲜度目标 |
| 来源准入和禁用审批流程 | `src/config/sources.ts` 有启用状态和可信度字段，但没有谁能批准新增/禁用来源的流程 |
| 真实访问量、性能目标和监控 | 没有生产监控、日志聚合、告警或性能预算证据 |
| 长期数据保留策略 | 没有数据库；`public/daily-news.json` 和内存缓存之外没有持久化证据 |

## 人工检查建议

| 建议 | 原因 |
| --- | --- |
| 确认 Daily News 的目标读者和主要使用频率 | 当前只能从 UI 和 README 推断是个人/原型新闻日报，无法确定正式产品定位 |
| 确认是否计划部署到公开服务器 | API CORS 当前为 `*`，且服务假设本地运行；公开部署会改变安全和运维要求 |
| 确认新增来源的评估标准 | 代码有 `credibility`、`enabled`、`mayHavePaywall`，但没有来源准入流程 |
| 确认翻译服务是否固定使用本地 OpenAI-compatible 服务 | README 只给出可选变量，不能确定供应商、模型和成本边界 |
| 确认是否需要保存历史日报 | 当前没有数据库或历史归档机制；如果需要，会影响数据设计和发布计划 |
