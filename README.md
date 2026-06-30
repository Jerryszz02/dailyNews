# Daily News

Daily News 是一个新闻日报原型：从可配置精选来源获取新闻，按公共重要性、用户偏好、时效性、来源可信度和内容质量排序，并在网页中展示密集时间线、当前热点、分类筛选和偏好新闻。

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

- 设置了 `FIRECRAWL_API_KEY`：通过 Firecrawl 搜索 `src/config/sources.ts` 中启用的来源。
- 没有设置密钥：使用 `src/data/firecrawlSnapshot.ts` 和 `src/data/sampleNews.ts` 中随项目保存的兜底数据。
- 实时 API 启动时生成一次缓存，之后按间隔刷新。

本地配置示例：

```bash
cp .env.example .env.local
# 在 .env.local 里填入 FIRECRAWL_API_KEY，不要把密钥发到聊天或提交到 git。
npm run generate
```

可选环境变量：

```bash
DAILY_NEWS_MAX_SOURCES=20
DAILY_NEWS_LIMIT_PER_SECTION=5
DAILY_NEWS_REFRESH_INTERVAL_MINUTES=15
PORT=4173
```

默认值是 `DAILY_NEWS_MAX_SOURCES=20`、`DAILY_NEWS_LIMIT_PER_SECTION=5`、`DAILY_NEWS_REFRESH_INTERVAL_MINUTES=15`、`PORT=4173`。

## API

```bash
curl http://127.0.0.1:4173/api/news
curl http://127.0.0.1:4173/api/health
```

`GET /api/news` 返回 `DailyNewsReport`，包含 `generatedAt`、`items`、`sourceCount` 和 `notes`。Firecrawl 密钥只在 Node 服务端读取，前端不接触密钥。

## 中文化边界

面向用户展示的新闻标题、摘要、来源名和页面固定文案应保持中文。英文来源名如果来自外部抓取结果，显示层会在 `src/App.tsx` 的 `sourceLabel` 中兜底映射；随项目保存的快照和示例数据也应尽量直接保存中文标题、摘要和来源名。

不要把 `public/daily-news.json` 当作唯一源数据：它是生成产物。修改快照或示例新闻时，应同步检查 `src/data/firecrawlSnapshot.ts`、`src/data/sampleNews.ts`，必要时重新生成 `public/daily-news.json`。

## 核心文件

- `src/config/sources.ts`：首批中英新闻来源配置。
- `src/config/scoring.ts`：排序权重和公共重要性关键词。
- `src/lib/scoring.ts`：可解释评分。
- `src/lib/dedupe.ts`：同一事件聚类去重。
- `scripts/newsService.ts`：Firecrawl 抓取、兜底合并和报告生成共享逻辑。
- `scripts/newsServer.ts`：实时 API 与生产静态资源服务。
- `scripts/generateDailyNews.ts`：Firecrawl 数据生成入口。
- `public/daily-news.json`：前端加载的生成结果。
- `src/App.tsx`：页面结构、分类切换、来源名显示映射。

## 验证

```bash
npm test
npm run build
```

如果改了页面显示，刷新 `http://127.0.0.1:5173/` 后确认首屏新闻、分类切换和移动宽度下的排版仍正常。
