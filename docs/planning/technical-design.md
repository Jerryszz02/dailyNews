# Daily News 技术设计

## 文档目的

把当前仓库证据转成后续实现可遵守的技术契约，避免修改数据生成、API、排序、可信度、分类或前端 fallback 时破坏已有行为。本文仅根据当前仓库可见内容整理；未在仓库中找到证据的内容均不做假设。

## 适用范围

适用于修改以下子系统：

- `src/config/sources.ts` 来源配置；
- `scripts/newsService.ts` 和 `scripts/generateDailyNews.ts` 报告生成；
- `scripts/newsServer.ts` API 与缓存；
- `src/lib/dedupe.ts`、`src/lib/scoring.ts`、`src/lib/trust.ts`、`src/lib/newsOrdering.ts` 新闻处理；
- `src/App.tsx` 前端加载、筛选和展示。

## Plan 或项目证据

| 证据 | 技术事实 |
| --- | --- |
| `docs/architecture.md` | 数据流为来源配置 -> 生成服务 -> 去重/排序/可信度 -> API/静态 -> 前端 |
| `scripts/newsService.ts` | 生成优先级为 Firecrawl keyless -> direct source fetch -> generated/static fallback |
| `scripts/newsServer.ts` | 服务端只有内存缓存，没有数据库；刷新并发通过 `refreshInFlight` 合并 |
| `src/App.tsx` | 浏览器加载优先级为 `/api/news` -> `/daily-news.json` -> `firecrawlSnapshotNews` |
| `src/lib/newsPipeline.ts` | 报告只包含启用来源；排序后过滤 `trust.shouldShow === false` |
| `src/lib/dedupe.ts` | 去重后为每个 cluster 选择唯一 `primaryCategory` |
| `src/lib/scoring.ts` | 排序分由公共重要性、偏好、时效、来源可信度和内容质量加权组成 |
| `src/lib/trust.ts` | 可信度独立于排序，并决定极低质量内容是否展示 |

## 选定方案

Daily News 采用本地优先的轻量架构：

1. 所有来源、分类、可信度基础信息保存在 TypeScript 配置中。
2. Node 侧负责外部抓取、翻译配置读取、报告生成和 API 缓存。
3. 前端只消费已经生成的 `DailyNewsReport`，不直接读取 secrets 或调用 Firecrawl。
4. 静态 JSON 和 checked-in snapshot 提供离线/失败兜底。
5. 排序和可信度分开计算：排序决定展示顺序，可信度决定标签和最低展示门槛。

## 子系统职责

| 子系统 | 文件 | 职责 | 维护约束 |
| --- | --- | --- | --- |
| 来源配置 | `src/config/sources.ts` | 定义来源、栏目、查询词、语言、地区、主分类、辅助分类、可信度、付费墙和启用状态 | 新来源必须显式设置 `primaryCategory`；不可靠来源应禁用而不是靠 UI 隐藏 |
| 类型契约 | `src/types.ts` | 定义来源、新闻项、cluster、评分、可信度和日报报告结构 | 改字段必须同步生成、API、前端和测试 |
| 生成服务 | `scripts/newsService.ts` | 读取本地 env，抓取 Firecrawl keyless，直接抓公开页面/feed，翻译英文-only 结果，合并 fallback，构建报告 | secrets 只在 Node 侧读取；不要把抓取放进浏览器 |
| 静态生成 | `scripts/generateDailyNews.ts` | 调用共享生成逻辑写入 `public/daily-news.json` | `public/daily-news.json` 是生成产物，不是源数据 |
| 本地 API | `scripts/newsServer.ts` | 提供 `/api/news`、`/api/health`、`/api/refresh`，生产式服务 `dist/` | 缓存为内存；无数据库；API 未准备好时返回 503 |
| 报告管线 | `src/lib/newsPipeline.ts` | 过滤启用来源、聚类、排序、过滤极低可信内容、生成 notes | `trust.shouldShow` 是最低质量门槛 |
| 去重分类 | `src/lib/dedupe.ts` | 按 URL 和 token overlap 聚合同事件，选择唯一主分类 | 分类页只能使用 `primaryCategory` |
| 排序 | `src/lib/scoring.ts` | 生成综合分和排序原因 | 保持可解释字段，不只输出 final score |
| 可信度 | `src/lib/trust.ts` | 生成可信度分级、原因和展示布尔值 | 低可信可展示，极低质量不展示 |
| 前端 | `src/App.tsx` | 加载报告、保存偏好、渲染导航、热点、搜索、时间线和设置 | 用户侧文案和内容保持中文；保留 `sourceLabel` 兜底 |

## 数据和状态流

### 生成侧

```text
src/config/sources.ts
  -> scripts/newsService.ts
  -> Firecrawl keyless search
  -> direct source page/feed fetch if keyless has no live items
  -> public/daily-news.json or src/data/firecrawlSnapshot.ts if no live items
  -> src/lib/newsPipeline.ts
  -> DailyNewsReport
```

生成侧关键状态：

| 状态 | 处理 |
| --- | --- |
| Firecrawl keyless 有结果 | 使用 Firecrawl 结果，并合并 `firecrawlSnapshotNews` 保持分类覆盖 |
| Firecrawl keyless 额度/限速/无实时结果 | 切换到直接公开来源页面/feed 抓取 |
| 直接抓取无结果 | 读取已生成 `public/daily-news.json`，失败再用 `firecrawlSnapshotNews` |
| 英文-only 结果且栏目不要求中文 | 有完整 `DAILY_NEWS_TRANSLATION_*` 时尝试翻译，否则跳过 |
| 来源抓取失败 | 记录 warning，继续处理其他来源 |

### 服务侧

```text
npm run api / npm run serve
  -> loadLocalEnv()
  -> initial refreshNews()
  -> cachedReport in memory
  -> periodic refresh by DAILY_NEWS_REFRESH_INTERVAL_MINUTES
  -> /api/news, /api/health, /api/refresh
```

服务侧关键状态：

| 状态 | 处理 |
| --- | --- |
| 初次刷新未完成 | `/api/news` 和 `/api/health` 返回 503 |
| 刷新成功 | 更新 `cachedReport`，清空 `lastError` |
| 已有缓存但本次无 live data | 保留旧缓存，设置 `lastError` |
| 刷新异常且已有缓存 | 保留旧缓存，`lastError` 记录错误 |
| 刷新异常且无缓存 | 请求失败，健康检查不可用 |

### 前端侧

```text
App mount
  -> loadStoredPreferences()
  -> refreshNews()
  -> readReport("/api/news")
  -> readReport("/daily-news.json")
  -> buildDailyReport(firecrawlSnapshotNews, defaultPreferences)
  -> render active view
```

前端关键状态：

| 状态 | 处理 |
| --- | --- |
| `activeView === "preferred"` | 使用 `selectPreferredCategoryItems` 筛选偏好类别并按时间排序 |
| `activeView` 是分类 | 使用 `item.primaryCategory === activeView` 筛选并按时间排序 |
| `activeView === "settings"` | 展示偏好设置，不展示新闻列表 |
| `searchQuery` 非空 | 对标题、摘要、来源、主分类、辅助分类和可信度标签做归一化搜索 |
| 每分钟轮询 | 再次调用 `refreshNews()` |

## 关键契约

| 契约 | 说明 |
| --- | --- |
| `DailyNewsReport.items` 应为 `RankedNewsItem[]` | 前端依赖 `score_breakdown`、`trust`、`sourceNames`、`primaryCategory` |
| `primaryCategory` 是分类页唯一依据 | `categories` 只能解释辅助标签，不能让一条新闻出现在多个分类页 |
| `trust` 独立于 `score_breakdown` | 低可信新闻可见但标记，`shouldShow` 为 false 的内容不展示 |
| 热点不使用用户偏好分 | `sortByHotScoreWithoutPreferences` 明确剔除 `user_preference` |
| secrets 不进浏览器 | Firecrawl 和翻译配置只能在 Node 脚本/API 中使用 |
| 静态 JSON 是生成产物 | 内容或来源变更应改 `src/data/firecrawlSnapshot.ts` 或 `src/config/sources.ts` 后再生成 |

## 错误处理和 fallback

| 场景 | 最小正确行为 |
| --- | --- |
| API 不可用 | 前端继续尝试 `/daily-news.json` 和 snapshot |
| 静态 JSON 缺失或无效 | 前端使用 `firecrawlSnapshotNews` 构建报告 |
| Firecrawl keyless 不可用 | 生成服务切换 direct source fetch |
| Direct fetch 单个来源失败 | 跳过该来源，继续其他来源 |
| 翻译配置缺失 | 英文-only 且需要中文体验的内容跳过，不泄露密钥 |
| 无效新闻缺少标题或 URL | `trust.shouldShow` 应为 false，报告过滤掉 |

## 实现指引

- 做行为改动时先确认受影响层：来源配置、生成服务、API、pipeline、排序/可信度、前端展示或测试。
- 新增 `DailyNewsReport` 字段时，同步更新 `src/types.ts`、`scripts/newsServer.ts` 响应、`src/App.tsx` 消费和测试 fixture。
- 新增分类时，同步更新 `Category` 类型、`src/App.tsx` 分类导航、`src/config/sources.ts`、去重关键字和偏好默认值。
- 新增来源时，先判断是否公开可访问；401、paywall 或访客验证不稳定的来源应禁用或只使用公开元数据。
- 改抓取逻辑时保留 timeout、逐来源容错和 fallback，避免一个来源失败导致整份日报不可用。
- 改排序或可信度时优先添加或更新 Vitest 用例，覆盖排序方向、低质量过滤和社交/官方/多信源信任差异。

## 验收标准

- `npm test` 通过。
- 涉及 TypeScript、前端或构建路径时 `npm run build` 通过。
- 涉及生成路径时 `npm run generate` 可写出有效 `public/daily-news.json`。
- 涉及 API 时 `npm run api` 后 `GET /api/health` 和 `GET /api/news` 行为符合 [api-design.md](api-design.md)。
- 涉及 UI 时浏览器检查偏好新闻、分类页、热点、搜索、设置和 fallback 提示。

## 待确认

| 项 | 影响 |
| --- | --- |
| 是否需要生产部署 | 会影响 CORS、日志、端口、进程管理、监控和安全边界 |
| 是否需要历史日报 | 会引入数据库或文件归档设计 |
| 是否需要并发多用户偏好 | 当前偏好只存在浏览器 `localStorage` |
| 是否固定翻译供应商 | 会影响错误处理、成本、速率限制和安全文档 |
| 来源新增审批标准 | 会影响 `credibility`、`enabled` 和 paywall 策略 |
