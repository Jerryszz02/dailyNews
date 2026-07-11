# Daily News 测试计划

## 文档目的

定义 Daily News 后续改动的最小验证路径，确保新闻生成、排序、去重、可信度、API fallback 和前端体验没有回退。本文仅根据当前仓库可见内容整理；未在仓库中找到证据的内容均不做假设。

## 适用范围

适用于修改产品行为、数据生成、API、排序、去重、可信度、分类、前端展示、中文化或来源配置的工作。

不适用于生产监控、真实用户压测、CI/CD 或长期数据质量报表，因为当前仓库没有这些系统证据。

## Plan 或项目证据

| 证据 | 测试事实 |
| --- | --- |
| `package.json` | 可运行 `npm test`、`npm run build`、`npm run generate`、`npm run verify-news`、`npm run upgrade-report`、`npm run api`、`npm run dev`、`npm run serve` |
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
| 来源配置、生成逻辑、fallback 数据 | 先用 `npm run verify-news` 做不落盘量化验收；需要发布静态报告时再运行 `npm run generate` |
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
| 首屏 | 显示质量概览、今日必知、重要进展和持续关注；三个层级无重复事件 |
| 分类 | 点击十个分类时直接引用 `stories` 的唯一 `primaryBeat`；无合格事件时显示明确空状态 |
| 搜索 | 输入事件标题、事实或来源关键词能同时过滤三个首页层级，结果标题不重复 |
| 设置 | 修改分类偏好后，刷新页面偏好仍保留；今日必知不随偏好变化 |
| 展开更多 | 分类事件超过首屏数量时按钮每次增加 18 个事件 |
| 证据状态 | 卡片显示 confirmed/developing/unverified 等状态、证据数和来源 |
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
| API 后台刷新失败 | 已有 last-known-good 仍返回 200，前端不应白屏 |
| 生成 JSON 过旧 | 维护者应通过 `npm run generate` 重建而不是手改产物 |

## Fixture 和测试数据

当前测试使用内联 fixture，没有独立 fixture 目录。维护建议：

- 新增排序规则时，在 `src/lib/scoring.test.ts` 添加最小新闻对象。
- 新增展示排序规则时，在 `src/lib/newsOrdering.test.ts` 添加最小 `RankedNewsItem`。
- 新增分类时，测试 fixture 要包含 `primaryCategory` 和 `categories` 的交叉情况。
- 新增来源类型时，至少覆盖可信度和排序影响。

## 性能和数据质量检查

当前实现已有 30 秒整轮硬截止、来源并发上限、V2 `coverage`/`quality` 摘要、量化验收和发布门槛，但仍没有生产监控 dashboard。可做的检查：

- `npm run generate` 不应因单个来源失败而整体失败；
- 本地 API 刷新日志应能说明使用 `Firecrawl keyless`、`Hybrid live fetch`、`Direct source fetch` 或 fallback；固定生成与 Vercel refresh 应为 direct-only；
- 报告 `sourceCount` 应合理反映启用来源覆盖；
- 新闻 URL 不应重复；
- `items` 中不应缺少 `trust` 或 `primaryCategory`。

## V2 重构验证计划与状态

本节对应 [news-curation-refactor-plan.md](news-curation-refactor-plan.md)。核心自动化与浏览器验证已具备；7–14 天 golden dataset、连续 7 天 shadow 和生产 P95 仍未完成。

当前已覆盖：来源覆盖与双入口、并发上限、整轮 deadline、过期实时数据 fallback、域名归因、中文信息量、事件持续更新聚类、低价值国际/体育降级、单源社交线索、V2 引用完整性、last-known-good、防回退发布门槛、只读 API、刷新鉴权、桌面/390px 布局和分类空状态。

### Golden dataset

生产默认切换前仍需建立 7–14 天人工标注数据集，每个事件至少标注：

- 是否属于 must-know、important、special-interest 或 noise；
- 哪些文章属于同一事件，哪些只是同主题；
- 主要 beat、scope、event type 和关键实体；
- 哪些来源为独立确认、同一通稿、原始来源或仅发现线索；
- 允许进入摘要的关键事实、数字、日期和出处；
- 是否为发展中、争议或更正事件。

Golden dataset 不包含 secret、登录后正文或付费墙全文。

### V2 自动化矩阵

| 领域 | 必须覆盖的场景 |
| --- | --- |
| 来源调度 | coverage matrix、健康降级、固定来源不垄断、熔断恢复 |
| 标准化 | canonical URL、域名归因、三种时间语义、跨语言标题 |
| 质量门槛 | 软文、列表页、旧闻、无事实摘要、单源社交爆料 |
| 事件聚类 | 同事件跨来源、持续更新、同主题不同事件、错误过度合并 |
| 证据状态 | confirmed/developing/disputed/corrected/unverified |
| 重要性 | 公共影响优先、偏好不隐藏 must-know、noise 不填充分类 |
| 多样性 | 来源、beat、实体软上限和无合格候选时允许为空 |
| 摘要 | 数字、人名、日期、机构和出处一致性；失败回退抽取式摘要 |
| 存储 | 幂等写入、latest 原子切换、失败运行不覆盖、报告回滚 |
| API | V2 字段、V1 `items` 兼容、last-known-good、非敏感错误 |

### V2 量化验收

初始目标：

- must-know 基准事件召回率不低于 90%；
- 首页人工价值精确率不低于 85%；
- 重复事件率不高于 5%；
- 错误来源归因和缺失发布时间均为 0；
- 通用模板摘要不高于 3%；
- 单一来源占正式事件不高于 20%；
- 有合格候选的 beat 全部被覆盖；
- `GET /api/news` 读取 latest report 的 P95 不高于 500 ms；
- 单轮生成 P95 初始目标不高于 30 秒，最终阈值按 Phase 0 基准校准。

### Shadow 验收

V2 已是代码、静态报告和 Vercel API 入口的默认结构，但尚无连续 shadow 证据。扩大正式使用前至少连续 7 天保留前后版本对照，人工比较：

- V2 是否遗漏 V1 中的高价值事件；
- V2 新增事件中有多少属于 noise；
- 事件聚类、来源证据和摘要是否可解释；
- 分类覆盖是否来自真实合格事件，而不是为了填数；
- V2 失败时 V1 或 last-known-good 是否仍可用。

Shadow 未达到量化门槛时，不进入默认切换阶段。

## 非目标

- 不要求端到端自动化浏览器测试，当前仓库没有 Playwright/Cypress 配置。
- 不要求生产压测；仓库有 Vercel 入口，但没有流量、监控或压测证据。
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
| 性能预算 | 生成已有 30 秒硬预算和推荐 P95 目标；页面加载与 API 读取 P95 尚无真实基准或监控 |
| 人工内容质量门槛 | 自动门槛已要求 10/10 分类、中文、新鲜度、时间顺序和成本预算；人工价值精确率仍需 golden dataset 校准 |
| 生产验收流程 | 已有本地量化命令和 Vercel 入口，但没有 CI、shadow、灰度与回滚 checklist |
