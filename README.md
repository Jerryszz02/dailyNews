# Daily News

Daily News 是一个事件级新闻日报：从可配置精选来源发现候选，把不同媒体对同一事件的报道合并为证据链，再按公共影响、事实状态和来源多样性输出“今日必知、重要进展、持续关注和分类深读”。

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
- Firecrawl 最多使用整轮前 8 秒；候选不足时继续并发直连公开来源页面/feed，并合并两路结果。
- 没有实时结果：使用已生成的 `public/daily-news.json`，再兜底到 `src/data/firecrawlSnapshot.ts`。
- 整轮采集默认 30 秒截止；新报告未通过绝对/相对质量门槛时保留 last-known-good。
- `GET /api/news` 只读已经发布的报告，不在用户请求内抓取外部来源。
- 静态报告先写临时文件并通过质量门槛，再原子替换 `public/daily-news.json`。

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
DAILY_NEWS_MAX_SOURCES=
DAILY_NEWS_LIMIT_PER_SECTION=5
DAILY_NEWS_REFRESH_INTERVAL_MINUTES=15
DAILY_NEWS_COLLECTION_BUDGET_MS=30000
DAILY_NEWS_SOURCE_CONCURRENCY=6
DAILY_NEWS_MAX_AGE_HOURS=72
DAILY_NEWS_REFRESH_TOKEN=
DAILY_NEWS_TRANSLATION_API_KEY=YOUR-DEEPSEEK-API-KEY
DAILY_NEWS_TRANSLATION_BASE_URL=
DAILY_NEWS_TRANSLATION_MODEL=
PORT=4173
```

默认抓取所有启用来源；只有需要人工限制来源数时才设置 `DAILY_NEWS_MAX_SOURCES`。默认值是 `DAILY_NEWS_LIMIT_PER_SECTION=5`、`DAILY_NEWS_REFRESH_INTERVAL_MINUTES=15`、`PORT=4173`。

`DAILY_NEWS_TRANSLATION_API_KEY` 是可选 secret；配置后默认使用 DeepSeek Flash（`https://api.deepseek.com` + `deepseek-v4-flash`）把非中文新闻改写为中文标题和摘要，并在摘要缺失或等于标题时生成中文概述。`DAILY_NEWS_TRANSLATION_BASE_URL` 和 `DAILY_NEWS_TRANSLATION_MODEL` 只在需要覆盖默认 DeepSeek 配置时填写。生产部署到 Vercel 时只在项目环境变量里配置 secret，不提交 `.env.local`。

## API

```bash
curl http://127.0.0.1:4173/api/news
curl http://127.0.0.1:4173/api/health
```

`GET /api/news` 返回 `DailyNewsReport` V2，包含完整 `stories`、`topStories`、`importantStories`、`watchlist`、`sections`、`coverage`、`quality`，并保留旧 `items` 兼容字段。生产环境的 `POST /api/refresh` 需要 `DAILY_NEWS_REFRESH_TOKEN`；未配置时端点不可用。翻译与刷新密钥只在 Node 服务端读取，前端不接触密钥。

## 中文化边界

面向用户展示的新闻标题、摘要、来源名和页面固定文案应保持中文。英文来源名如果来自外部抓取结果，显示层会在 `src/App.tsx` 的 `sourceLabel` 中兜底映射；随项目保存的快照和示例数据也应尽量直接保存中文标题、摘要和来源名。

不要把 `public/daily-news.json` 当作唯一源数据：它是生成产物。修改快照或来源配置时，应同步检查 `src/data/firecrawlSnapshot.ts` 和 `src/config/sources.ts`，必要时重新生成 `public/daily-news.json`。

## 核心文件

- `src/config/sources.ts`：中英新闻来源、专属查询词、主分类和可信度基础配置。
- `src/config/scoring.ts`：排序权重和公共重要性关键词。
- `src/lib/scoring.ts`：可解释排序评分。
- `src/lib/trust.ts`：独立低/中/高可信度评估。
- `src/lib/dedupe.ts`：同一事件聚类去重，并确定唯一主分类。
- `src/lib/curation.ts`：候选质量门槛、事件证据、事实状态、公共影响分层和集合级选择。
- `src/lib/sourceCoverage.ts`：按栏目缺口、来源角色、地区和健康状态选择来源。
- `scripts/newsService.ts`：Firecrawl 抓取、直接来源抓取、翻译、兜底合并和报告生成共享逻辑。
- `scripts/newsServer.ts`：实时 API 与生产静态资源服务。
- `scripts/reportStore.ts`：last-known-good 读取、V1→V2 迁移和发布质量门槛。
- `scripts/generateDailyNews.ts`：报告生成入口。
- `public/daily-news.json`：前端加载的生成结果。
- `src/App.tsx`：页面结构、分类切换、来源名显示映射。

## 验证

```bash
npm test
npm run build
```

如果改了页面显示，刷新 `http://127.0.0.1:5173/` 后确认首屏新闻、分类切换和移动宽度下的排版仍正常。
