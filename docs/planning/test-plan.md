# Daily News 测试计划

## 文档目的

定义 Daily News 后续改动的最小验证路径，确保新闻生成、排序、去重、可信度、API fallback 和前端体验没有回退。本文仅根据当前仓库可见内容整理；未在仓库中找到证据的内容均不做假设。

## 适用范围

适用于修改产品行为、数据生成、API、排序、去重、可信度、分类、前端展示、中文化或来源配置的工作。

不适用于生产监控、真实用户压测、CI/CD 或长期数据质量报表，因为当前仓库没有这些系统证据。

## Plan 或项目证据

| 证据 | 测试事实 |
| --- | --- |
| `package.json` | 可运行 `npm test`、`npm run build`、`npm run generate`、`npm run api`、`npm run dev`、`npm run serve` |
| `README.md` | 推荐 `npm test`、`npm run build`，页面改动需人工检查 |
| `docs/runbook.md` | smoke check 包含 `/api/health` 和 `/api/news` |
| `src/lib/scoring.test.ts` | 覆盖排序、偏好影响、可信度、低质量过滤和去重 |
| `src/lib/newsOrdering.test.ts` | 覆盖时间排序、偏好列表和热点去除用户偏好分 |
| `src/App.tsx` | 需要人工验证 API fallback、搜索、分类、热点、设置和展开更多 |

## 验证矩阵

| 改动类型 | 最小验证 |
| --- | --- |
| 排序、去重、可信度、分类逻辑 | `npm test` |
| TypeScript 类型、前端组件、构建路径 | `npm run build` |
| 来源配置、生成逻辑、fallback 数据 | `npm run generate`，必要时检查 `public/daily-news.json` |
| API 路由、刷新缓存、服务端 env | `npm run api` 后 curl `/api/health`、`/api/news`、必要时 `POST /api/refresh` |
| UI 布局、中文文案、移动端 | `npm run dev` 后浏览器人工检查 |
| 生产式本地服务 | `npm run serve` 后检查页面和 API |
| 文档-only 改动 | 读文档自查链接、路径、命令和 `待确认` 是否准确 |

## 自动化测试

### `npm test`

目的：验证核心纯逻辑。

当前覆盖：

| 文件 | 覆盖点 |
| --- | --- |
| `src/lib/scoring.test.ts` | 公共重要性优先于纯偏好、偏好改变排序、官方/多信源高可信、社交单点低可信、无标题/URL 过滤、同事件聚类 |
| `src/lib/newsOrdering.test.ts` | 常规列表按时间排序、偏好类别筛选和时间排序、热点排序不使用用户偏好分 |

适用场景：

- 修改 `src/lib/scoring.ts`；
- 修改 `src/lib/trust.ts`；
- 修改 `src/lib/dedupe.ts`；
- 修改 `src/lib/newsOrdering.ts`；
- 修改 `src/config/scoring.ts`、`src/config/preferences.ts` 或 `src/config/sources.ts` 中会影响排序/过滤的字段。

### `npm run build`

目的：验证 TypeScript 和 Vite 构建。

适用场景：

- 修改 `src/App.tsx`、`src/types.ts`、配置、样式或任何 TypeScript 文件；
- 修改 API/生成代码中被 TypeScript 编译引用的类型契约；
- 发布或交付前的综合检查。

### `npm run generate`

目的：验证生成链路能产出静态日报。

适用场景：

- 修改 `scripts/newsService.ts`；
- 修改 `scripts/generateDailyNews.ts`；
- 修改 `src/config/sources.ts`；
- 修改 fallback 数据或生成报告结构。

验收：

- 命令完成；
- `public/daily-news.json` 是合法 JSON；
- `items` 非空；
- 每条新闻有 `primaryCategory` 和 `trust`；
- 不包含 secret 或 `.env.local` 值。

## API Smoke Test

启动 API：

```bash
npm run api
```

检查健康状态：

```bash
curl http://127.0.0.1:4173/api/health
```

期望：

- 初始刷新完成前可接受 `503`；
- 刷新完成后返回 `ok: true`；
- `itemCount` 大于 0；
- `lastError` 为 `null` 或可解释的刷新错误。

检查新闻报告：

```bash
curl http://127.0.0.1:4173/api/news
```

期望：

- 成功时状态为 `200`；
- 响应包含字符串 `generatedAt`；
- `items` 是非空数组；
- item 包含 `primaryCategory`、`trust`、`score_breakdown`。

手动刷新：

```bash
curl -X POST http://127.0.0.1:4173/api/refresh
```

期望：

- 成功时返回 `{ "ok": true, "generatedAt": ... }`；
- 失败时返回 `{ "ok": false, "error": ... }`，且不会把 secret 写入响应。

## 前端人工检查

启动开发环境：

```bash
npm run api
npm run dev
```

打开：

```text
http://127.0.0.1:5173/
```

检查项：

| 场景 | 验收 |
| --- | --- |
| 首屏 | 显示偏好新闻、状态面板、当前热点和时间线 |
| 分类 | 点击 AI、科技、财经、国际、国内、政策、社会、科学、体育、娱乐时，新闻按 `primaryCategory` 过滤 |
| 搜索 | 输入标题、摘要、来源或可信度关键词能过滤结果 |
| 设置 | 修改地区/语言和分类偏好后，刷新页面偏好仍保留 |
| 展开更多 | 超过首屏数量时按钮每次增加 18 条 |
| 可信度 | 每条新闻显示高/中/低可信和原因 |
| 中文化 | 页面固定文案、来源显示、标题和摘要尽量为中文 |
| API 失败 | 停止 API 后页面仍能显示静态或 snapshot 兜底，并显示 fallback 提示 |
| 移动宽度 | 关键文本不重叠，导航、搜索和新闻卡片可读 |

## 回归场景

| 场景 | 为什么重要 |
| --- | --- |
| 同一事件来自多个来源 | 必须聚类，并提升可信度/公共重要性 |
| 社交媒体单点爆料 | 可以显示但应为低可信，不能伪装成高可信 |
| 官方来源新闻 | 应提升可信度 |
| 缺少标题或 URL | 不应进入展示列表 |
| 英文-only 来源无翻译配置 | 应跳过或有中文兜底，不能破坏中文体验 |
| 分类交叉新闻 | 只能进入一个主分类页，辅助分类只做标签 |
| API 初始未准备好 | 前端应 fallback，不应白屏 |
| 生成 JSON 过旧 | 维护者应通过 `npm run generate` 重建而不是手改产物 |

## Fixture 和测试数据

当前测试使用内联 fixture，没有独立 fixture 目录。维护建议：

- 新增排序规则时，在 `src/lib/scoring.test.ts` 添加最小新闻对象。
- 新增展示排序规则时，在 `src/lib/newsOrdering.test.ts` 添加最小 `RankedNewsItem`。
- 新增分类时，测试 fixture 要包含 `primaryCategory` 和 `categories` 的交叉情况。
- 新增来源类型时，至少覆盖可信度和排序影响。

## 性能和数据质量检查

当前仓库没有性能预算或数据质量 dashboard。可做的轻量人工检查：

- `npm run generate` 不应因单个来源失败而整体失败；
- API 刷新时日志应能说明使用 `Firecrawl keyless`、`Direct source fetch` 或 `Firecrawl snapshot`；
- 报告 `sourceCount` 应合理反映启用来源覆盖；
- 新闻 URL 不应重复；
- `items` 中不应缺少 `trust` 或 `primaryCategory`。

## 非目标

- 不要求端到端自动化浏览器测试，当前仓库没有 Playwright/Cypress 配置。
- 不要求生产压测，当前仓库没有生产部署证据。
- 不验证外部新闻事实真伪，只验证项目的排序、可信度标签和展示规则。
- 不要求每次文档-only 改动运行完整构建。

## 实现指引

- 先跑最小相关检查，再根据改动范围扩大到 `npm run build`。
- 如果修 bug，优先添加能复现的 Vitest 用例。
- 如果改 UI，至少做一次浏览器人工检查。
- 如果改生成或来源配置，检查生成报告是否有中文标题/摘要、`primaryCategory`、`trust` 和非空 URL。
- 如果改 API，检查 curl 响应状态码和前端 fallback。

## 验收标准

一次合格的行为改动至少应报告：

- 改了什么；
- 跑了哪些命令；
- 每个命令是否通过；
- 哪些人工检查已做；
- 哪些风险或 `待确认` 尚未覆盖。

## 待确认

| 项 | 需要确认的问题 |
| --- | --- |
| 是否需要浏览器自动化测试 | 当前只有人工 UI 检查建议，没有 E2E 配置 |
| 是否需要 CI | 仓库证据未显示 GitHub Actions 或其他 CI 配置 |
| 性能预算 | 未定义页面加载、API 刷新或生成耗时目标 |
| 数据质量门槛 | 未定义每次生成必须覆盖多少来源、多少分类或多少新闻 |
| 生产验收流程 | 当前只有本地命令，没有发布前 checklist |
