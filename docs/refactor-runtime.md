# 重构版运行与实施记录

更新时间：2026-10-03（Asia/Shanghai）。适用于当前实施分支；生产仍是独立旧系统，未切换。需求和阶段出口以 [已批准计划](planning/aihot-v2-refactor-plan.md) 为准。

## P1 基准与运行

固定 AIHOT `3343fe2b20db4be7269113752d82d3992fc52b6b` 已导入 `apps/{web,api,worker}`、`packages/{backend,contracts}`、`industry` 和 `database`。来源文件校验清单、MIT/NOTICE、旧规则提交与锁文件均保留在 [基准目录](../reference/baselines/README.md)。旧 `src`、`api`、`supabase`、新闻脚本和 fallback 数据保留，不用于新底座启动。

Node >=24.11。默认所有外部调用阀关闭，`industry/sources.json` 在 P1 为空；模型榜和 Codex 重置监控关闭，飞书与 IndexNow 关闭。`init-env.ts` 不覆盖已有文件，不打印随机凭据，模型名留空等待官方核实。新 PostgreSQL 必须独立，不能使用旧 Supabase 的地址。

Docker Compose 的项目名为 `dailynews-refactor`，独立 `db` / `data` 卷，网页仅绑定 `127.0.0.1:3300`。初始化与构建见根 README。P1 本机没有 Docker，实际验证使用从 [Postgres.app 官方发布](https://postgresapp.com/downloads.html) 提取的 PostgreSQL 17.11，安装在当前 worktree 的 `.data/runtime/pgsql17`；数据目录 `.data/postgres17`，端口 55432，未安装系统服务。数据库 `dailynews_refactor` 用于离线 smoke，`dailynews_refactor_test` 只用于测试，互不共享资料。

直接运行的三个入口（`.env` 中设置独立 DATABASE_URL、SITE_URL、API_BASE_URL、API_PORT、WEB_PORT）：

```bash
node --env-file=.env scripts/migrate.ts
node --env-file=.env scripts/seed.ts
npm run build
node --env-file=.env apps/api/src/main.ts
node --env-file=.env apps/worker/src/main.ts
node --env-file=.env apps/web/server.ts
```

默认本地 API 为 3301，网页为 3300。停止本次进程使用其确切 PID 的 SIGTERM；PostgreSQL 用对应数据目录的 `pg_ctl stop`。不停止规范 checkout 或其他项目的服务。试验数据保留在忽略目录，不提交数据库或运行凭据。

## 旧系统盘点与兼容边界

- 来源配置 169 个、栏目 187 个；14 个禁用，包含 Reuters、Bloomberg、FT、WSJ、The Athletic 和 9 个待核验 X 账号。76 个 X 配置中 67 个身份已确认、9 个待确认。配置主分类分布及每个栏目入口见 `reference/baselines/legacy-sources.json`；P3 再逐项适配，配置存在不证明可采集。
- 仓库内实际 `/api/news` 产品调用者是 `src/App.tsx`，30 秒轮询紧凑 `view=web`，主动重载加 `reload=1`；另有旧运维脚本。仓库外消费者、生产流量、Cron 和线上数据量未验证。
- 旧页面没有站内新闻详情 permalink，标题链接到原文。事件 `event-*`、候选 URL hash ID、日报 `daily-YYYY-MM-DD` 和报告引用在 P4 形成显式兼容边界；旧 refresh/cron 不映射到无鉴权新管理入口。
- 浏览器旧持久状态只有 `daily-news-preferences`：topicWeights、preferredSources、blockedKeywords、boostedKeywords。未发现旧收藏/已读存储；不宣称已迁移用户不存在的数据。
- tracked fallback 有 47 stories、47 items、13 个来源，生成于 2026-07-09，没有历史日报版次；TS fallback 为 14 条、4 来源、覆盖十类。它们是本地回滚材料，不是完整 Supabase 历史归档。原始文件及 SHA 已保留；旧数据库/附件导出和恢复验证属于后续独立步骤。
- `vercel.json` 使用 [git.deploymentEnabled=false](https://vercel.com/docs/project-configuration/git-configuration) 防止本重构分支的 Git 推送触发部署；没有修改 Vercel 账户或现网。旧文档 PR 的 Vercel 例外不适用于代码检查。

## P1 已执行检查

2026-10-03，本地 Node 24.18.0 / PostgreSQL 17.11：

- 类型检查、网页生产构建通过。
- 固定基准的 38 项数据库迁移在独立空库全部应用，重复运行不新增迁移。
- 后端 566 个测试通过；新增运行默认安全测试 2 个通过；网页 31 个测试通过。提供商测试使用本地 stub。
- `scripts/smoke.ts` 的 30 个网页/机器出口检查通过（含 RSS、API、MCP、品牌资源）。Chrome 首页显示 Daily News 与空内容状态。
- 离线 smoke 数据库的 sources、articles、receipts 均为 0；没有把旧 fallback 填入新公开池。

P1 PR [#15](https://github.com/Jerryszz02/dailyNews/pull/15)（`be72e51`）的 app-tests 与 database-tests 已通过；Vercel 检查为 Account is blocked，PR 保持未合并。CI 使用 Node 24、PostgreSQL 17、构建/测试与 Compose smoke。本机没有 Docker，不能把本地直接 PostgreSQL 验证说成已完成本机 Compose 验证。

## P2 分类与双策略（本地出口通过）

`industry/taxonomy.ts` 的主分类固定为十类，AI 的七个内容类型单独保留。结构分类先执行，只有 AI 分支进入原版 prefilter、双评分和内容理解。原版 `selection.ts` 与核心提示词通过字节级快照检查；UNKNOWN 继续分析，BLOCK 每篇每个 revision 最多一次非 AI 复核，重复任务复用结论。空分类在同 revision 最多两次尝试，之后保留待处理，新材料或显式重评才恢复。未分类或分析已失效的材料也不能通过详情、Markdown 或事件证据页绕过公开门槛；这是相对基准未分析材料可保留 noindex 详情页的明确适配。

非 AI 的公共重要性、事实状态和 top/important/watchlist 集合由 `dailynews/non-ai.ts` 确定性适配器计算。固定旧 SHA 的原函数生成 70 个 fact 的 golden 数据，逐项对照九类与集合限额。分数类型 `legacy_curation_total` 与 AI 注意力评分分别记录，不能跨策略混排。分类与组稿的来源提示只提供背景，不强制主分类。

0042/0043 增加 append-only `editorial_decisions`、`fact_editorial_state`、发布策略元数据、分类重试及分析签名。模型分析提交与发布都校验 material revision、人工分类、来源 tier、完整 taxonomy/渲染提示词、模型和规则版本。不同 URL 自动归并要求初判与需要时的复判都达到 0.8；同 URL 的确定性去重保留。

worker 启动与五分钟任务检查最近 72 小时正常新增资料的签名，时间边界重算每分钟执行。来源/模型/人工分类变更显式失效并入队；旧历史只接受明确 article IDs。签名固定的任务复用同一付费身份。测试可显式允许历史 rule/replay fixture；默认运行不接受未签名的新模型结果。

已覆盖代表稿替换、40 条集合挤出、旁及/综合稿排除、跨策略改类、101 个成员分批重评、材料修订即时撤销、许可变更及账本 remove/upsert。2026-10-03 在新建隔离库完成 P2/P3 联合全量回归：604/604 通过（其中来源迁移新增 6 项属于 P3）；类型检查、网页构建和 31 项网页测试通过。旧规则 70 个 fact 的差分一致，AI 核心快照未变。PR 检查另行记录，不沿用 P1 结果。

## P3 来源迁移（离线出口通过）

冻结的 169 个来源完整映射为 187 个栏目，保留 P1 的 12 位 sectionId、旧来源 ID、hostname 证据口径和禁用理由。[逐项清单](source-migration-inventory.md) 记录读者链接、允许域名/路径、适配器、发布者与 AI tier 依据；全部默认停用。AI tier 只继承固定上游已确认发布者，其余暂为 T2 并标明待核验，不由旧 credibility 分数换算。热点合并同一发布者的栏目与官方账号，非 AI 旧身份口径保持独立。

新增官方 X、news sitemap 及 Firecrawl keyless SDK 回退。X 必须有显式开关与官方凭据；未知账号和旧付费墙禁用状态保留。网页须填写经过验证的选择器；未验证迁移行即使 force 也不采集。Firecrawl 默认不开，启用需要逐源、运行开关及显式预算，初始额度为 0。失败不推进 cursor，不注入 fallback 新闻。

0044 在隔离库应用并导入 187 行，启用 0 行。新增来源测试 6 项、关联旧来源测试合计 18 项通过；联合后端全量 604/604、类型与构建通过。代表样本字段、URL 边界、官方 X 分页/重复、失败 cursor 与零预算均在本地 fixture 验证。真实网页选择器、各站可访问性和 reader URL 留给 P5 有界实抓；未将“有配置”当成“实抓成功”。

## P4 产品与公开出口

站点、v1 API、RSS、MCP 和事件证据共用公开准备度与释放时间门槛。最终无关、未分类、缺少摘要或尚未释放的精选不能通过详情、Markdown、OG 或收藏可用性绕过门槛；已准备好但低分、未入选的新闻仍在全部动态。撤回与许可矩阵继续生效。

条目增加 `scoreKind`、`importanceTier`、`factStatus`，网页与后台分别标注 AI 注意力、公共重要性和事实状态。非 AI 未入选代表稿也读取当前 fact 决策。混合策略代表排序不直接比较两套分数。同策略 AI 继续使用其分数偏好。公开 OpenAPI 版本为 2.2.0；旧增量账本的缺失元数据在读出时明确补 null，不改写历史记录或重置同步 epoch。

`/all?personal=1` 使用本机偏好筛选、排序当前公开页，不改变公共选择。旧 `daily-news-preferences` 的四字段一次性迁到 v2；降权关键词不删除公共新闻，没有虚构旧收藏或已读迁移。API 与旧 ID 的边界见 [旧接口过渡](legacy-api-transition.md)：未配置旧服务时 `/api/news` 明确返回 503，旧 refresh/cron 返回 410；47 条冻结 fallback 仅在带历史标记的归档入口读取，不灌入新池。

0045 增加 `public_ready_at`。日报使用上海 08:00 前一整天窗口，AI 取已释放精选，非 AI 取当前公开、非 noise 的事实代表稿，最多 24 个事实。先覆盖各分类再轮转补位，最终按时间排列。首次公开、首次合格决策及 AI 释放时间防止刚处理的旧文章回填早先版次；同一有效决策重复发布不移动首次准备时间。自动任务复用已发布版次，显式纠错才增加修订。周报/月报继续取精选候选，跨策略按时间编排。

2026-10-03，新空库 `dailynews_p4_final_test` 完成 42 个迁移与后端 **618/618** 测试。完整类型检查、网页生产构建和 35/35 网页测试通过；31 个网页/机器出口 smoke 通过。Chrome 验证十类导航、8 条精选与10条全部动态的差异、未入选体育稿详情及公共重要性/事实标识、偏好连续编辑与刷新保持、日报空状态；使用专门标注的离线样例库，`receipts=0`，不代表真实采集质量。

## 后续阶段

P2 PR [#16](https://github.com/Jerryszz02/dailyNews/pull/16) 依赖 #15；P3 PR [#17](https://github.com/Jerryszz02/dailyNews/pull/17) 依赖 #16。两者当前提交的 app-tests 与 database-tests 通过，Vercel 为 Account is blocked，均未合并。P4 完成离线产品验收后独立提交依赖 PR。P5 将在明确预算与固定样本保护下真实试运行，报告质量、费用、延迟和积压；离线通过不代表 P5 完成。

每次改动本说明描述的入口、数据流或安全阀，同 PR 更新本文件。生产切换、删旧库、采购和恢复历史 burn-in/soak/observer/heartbeat 不在授权内。
