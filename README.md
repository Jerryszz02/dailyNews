# Daily News

Daily News 是一个事件级新闻日报：从已准入来源发现候选，把不同媒体对同一事件的报道合并为证据链，并把最近 24 小时的全部有效事件放入首页“全部最新”，精选与分类内容位于其后。

公开仓库：<https://github.com/Jerryszz02/dailyNews>

## 运行

```bash
npm install
npm run generate
npm run dev
```

开发服务器默认监听 `http://127.0.0.1:5173/`。

实时 API 开发：

```bash
npm run api
npm run dev
```

`npm run api` 默认监听 `http://127.0.0.1:4173/`，Vite 会把 `/api` 代理到这个服务。

生产式本地运行：

```bash
npm run serve
```

该命令会先构建前端，再由 Node 服务托管 `dist/` 和 `/api/news`。

## 数据生成

`npm run generate` 会写入 `public/daily-news.json`，前端在 API 不可用时会加载这个文件。生成逻辑在 `scripts/generateDailyNews.ts`，实时 API 复用 `scripts/newsService.ts`：

- 默认不需要 Firecrawl API key：优先通过 Firecrawl keyless 搜索覆盖调度器选中的来源。
- Firecrawl 的 web/news 结果与公开页面、feed、sitemap 直连采集并发执行；每个网络请求独立超时，初始 URL 与重定向后的最终 URL 都必须属于来源允许域名。
- 没有实时结果：保留 last-known-good 的原始 `reportId/generatedAt`，不会把旧新闻重盖成当前时间；静态 `npm run generate` 会报错并保留原文件。
- 60 秒函数上限内，采集阶段默认使用 45 秒，保留约 10 秒完成 72 小时候选读取、报告构建与原子提交。局部来源、解析或翻译失败会标记 `partial/degraded`，不会冻结其他有效变化。
- `GET /api/news` 只读已经发布的报告，不在用户请求内抓取外部来源。
- 静态报告先写临时文件并通过结构不变量校验，再原子替换 `public/daily-news.json`。
- 生产每 2 小时由 Supabase Cron 调用受保护 `/api/cron`；每轮最多 11 源，其中 9 个用于正常公平轮转、最多 2 个优先重试 partial/failed。成本控制模式下，49 个 `enabled && approved` 来源约需 10 小时完成一轮覆盖。
- Supabase 保存来源状态、近 72 小时候选、刷新租约/运行和不可变报告；来源结果、候选、指标、可选 snapshot 与 latest pointer 通过版本化 RPC 在一个事务中完成。

只把已有静态报告离线升级为 V2，不访问新闻源：

```bash
npm run upgrade-report
```

本地配置示例：

```bash
cp .env.example .env.local
npm run generate
```

可选环境变量：

```bash
DAILY_NEWS_MAX_SOURCES=11
DAILY_NEWS_LIMIT_PER_SECTION=5
DAILY_NEWS_REFRESH_INTERVAL_MINUTES=120
DAILY_NEWS_COLLECTION_BUDGET_MS=45000
DAILY_NEWS_SOURCE_CONCURRENCY=11
DAILY_NEWS_MAX_AGE_HOURS=72
SUPABASE_URL=
SUPABASE_SECRET_KEY=
CRON_SECRET=
DAILY_NEWS_REFRESH_TOKEN=
DAILY_NEWS_TRANSLATION_API_KEY=YOUR-DEEPSEEK-API-KEY
DAILY_NEWS_TRANSLATION_BASE_URL=
DAILY_NEWS_TRANSLATION_MODEL=
PORT=4173
```

`enabled` 只控制是否抓取，`admission: approved` 才允许发布。生产默认每轮最多抓取 11 个到期来源（9 个正常轮转、最多 2 个失败重试）；静态生成未设置 `DAILY_NEWS_MAX_SOURCES` 时仍可覆盖全部已启用且已准入来源。`SUPABASE_SECRET_KEY`、`CRON_SECRET` 和 `DAILY_NEWS_REFRESH_TOKEN` 都只能存在于服务端环境，不能使用 `VITE_` 前缀。

`DAILY_NEWS_TRANSLATION_API_KEY` 是可选 secret；配置后默认使用 DeepSeek Flash（`https://api.deepseek.com` + `deepseek-v4-flash`）把非中文新闻改写为中文标题和摘要，并在摘要缺失或等于标题时生成中文概述。`DAILY_NEWS_TRANSLATION_BASE_URL` 和 `DAILY_NEWS_TRANSLATION_MODEL` 只在需要覆盖默认 DeepSeek 配置时填写。生产部署到 Vercel 时只在项目环境变量里配置 secret，不提交 `.env.local`。

## API

```bash
curl http://127.0.0.1:4173/api/news
curl http://127.0.0.1:4173/api/health
```

`GET /api/news` 默认返回完整 `DailyNewsReport` V2、兼容 `items`，并增加 `latestStories` 与刷新元数据；旧 V2 会在读取时自动派生这些字段。普通读取使用 30 秒共享缓存；仅紧凑视图允许 `view=web&reload=1`，该响应使用 `no-store`，并受短时服务端读取合并与每客户端限流保护。`servingMode`、`pipelineStatus`、`contentStatus` 分别表达服务来源、流水线健康和内容新鲜度；存在有效 last-known-good 时 `/api/news` 与 `/api/health` 均返回 200 并如实标记 degraded/stale，完全没有可服务报告时才返回 503。

Supabase 首次部署顺序见 [发布计划](docs/planning/release-plan.md)：migration dry-run/push 后运行 `npm run bootstrap:supabase`，再配置 Vault 并安装 2 小时 cron。bootstrap 保留 bundled 报告原始时间，因此旧基准不会被标成 fresh。

历史生产验收证据由确定性本地脚本记录，不依赖 AI heartbeat。正式 burn-in/soak 已取消且本地 observer 当前停止；下面的只读命令只用于确认已有 observer 状态，不能用来恢复验收：

```bash
npm run monitor:production -- status --output .production-acceptance/current
```

历史启动、停止和重建基线命令见 [运维手册](docs/runbook.md)。输出目录中的 `summary.json` 记录验收阶段、进度和判定，但不能单独证明后台进程仍在运行；报告 observer 正在运行前，必须执行上述 `status` 命令并确认 `monitorProcess.running` 为 `true`。生产 alias 切换到新 deployment 后，旧窗口必须停止，且未经明确批准不得新建或续接验收窗口。

## 中文化边界

面向用户展示的新闻标题、摘要、来源名和页面固定文案应保持中文。英文来源名如果来自外部抓取结果，显示层会在 `src/App.tsx` 的 `sourceLabel` 中兜底映射；随项目保存的快照和示例数据也应尽量直接保存中文标题、摘要和来源名。

不要把 `public/daily-news.json` 当作唯一源数据：它是生成产物。修改快照或来源配置时，应同步检查 `src/data/firecrawlSnapshot.ts` 和 `src/config/sources.ts`，必要时重新生成 `public/daily-news.json`。

## 核心文件

- `src/config/sources.ts`：中英新闻来源、准入状态、允许域名、审核说明、发布角色、查询词和主分类。
- `src/config/scoring.ts`：排序权重和公共重要性关键词。
- `src/lib/scoring.ts`：可解释排序评分。
- `src/lib/trust.ts`：兼容旧报告的事实标签；`shouldShow` 恒为 true，不参与收录、层级或排序。
- `src/lib/dedupe.ts`：同一事件聚类去重，并确定唯一主分类。
- `src/lib/curation.ts`：候选有效性、事件证据、事实状态、公共影响分层和集合级软重排。
- `src/lib/sourceCoverage.ts`：按持久 due time 公平轮转来源，并兼顾栏目、来源角色、地区和健康状态。
- `src/lib/freshness.ts`：从报告真实 `dataAsOf/generatedAt` 计算 fresh/stale，并用 durable 尝试/错误状态区分 degraded；成功检查时间只单独展示。
- `scripts/newsService.ts`：Firecrawl 抓取、直接来源抓取、翻译、候选采集和静态兼容生成逻辑。
- `scripts/newsRefresh.ts`：租约、选源、完整分页读取 72 小时候选池、结构不变量、内容 hash 和原子发布 orchestrator。
- `scripts/supabaseNewsStore.ts`：server-only Supabase RPC adapter。
- `scripts/newsServer.ts`：实时 API 与生产静态资源服务。
- `scripts/reportStore.ts`：last-known-good 读取、V1→V2 迁移和发布结构不变量。
- `supabase/migrations/`：数据库表、RLS、RPC、fencing lease、回滚和 Supabase Cron 安装函数。
- `scripts/generateDailyNews.ts`：报告生成入口。
- `public/daily-news.json`：前端加载的生成结果。
- `src/App.tsx`：页面结构、分类切换、来源名显示映射。

## 验证

```bash
npm test
npm run test:integration
npm run build
npm run test:db
git diff --check
```

如果改了页面显示，刷新 `http://127.0.0.1:5173/` 后确认首屏新闻、分类切换和移动宽度下的排版仍正常。
