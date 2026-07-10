# Daily News 技术设计

## 文档目的

记录当前事件级 V2 的实现契约。修改来源、采集、选题、API、静态报告或前端时，应以本文和 [news-curation-refactor-plan.md](news-curation-refactor-plan.md) 的实施状态为准。

## 当前架构

```text
src/config/sources.ts
  -> src/lib/sourceCoverage.ts
  -> Firecrawl keyless（最多 8 秒）+ 有限并发 direct fetch
  -> 72 小时新鲜度与 30 秒整轮截止
  -> src/lib/curation.ts 质量门槛
  -> src/lib/dedupe.ts 事件聚类
  -> evidence / status / public impact / tier / diversity
  -> DailyNewsReport V2
  -> scripts/reportStore.ts 发布门槛与 last-known-good
  -> GET /api/news 只读
  -> src/App.tsx 事件级首页与分类引用
```

## 子系统职责

| 子系统 | 文件 | 当前职责 |
| --- | --- | --- |
| 来源注册表 | `src/config/sources.ts` | 来源、栏目、查询词、主分类、语言、地区、可信度和访问边界 |
| 覆盖调度 | `src/lib/sourceCoverage.ts` | 按未覆盖 beat、单入口 beat、来源类型、地区、可信度和可选健康状态选源 |
| 采集服务 | `scripts/newsService.ts` | Firecrawl/直连、中文化、发布时间、域名归因、并发、总预算、新鲜度和 fallback |
| 候选门槛 | `src/lib/curation.ts` | 拒绝缺身份/时间、模板摘要、推广内容 |
| 事件聚类 | `src/lib/dedupe.ts` | canonical URL、标题相似度、中文连续文本、时间窗和共享上下文聚类；唯一主分类 |
| 信任与兼容排序 | `src/lib/trust.ts`, `src/lib/scoring.ts` | 最低展示门槛和旧 `items` 的可解释排序；中文摘要使用语言感知信息量 |
| 事件选题 | `src/lib/curation.ts` | evidence、independence group、status、event type、公共影响、四级 tier 和多样性选择 |
| 报告管线 | `src/lib/newsPipeline.ts` | 输出 V2 `stories`、首页三层、sections、coverage、quality 和兼容 `items` |
| 报告存储 | `scripts/reportStore.ts` | bundled report 读取、V1→V2 升级、内存 latest、绝对/相对发布门槛 |
| API | `scripts/newsApi.ts`, `scripts/newsServer.ts` | 只读 `/api/news`、健康状态、受保护刷新和静态服务 |
| 静态发布 | `scripts/generateDailyNews.ts`, `scripts/upgradeDailyNewsReport.ts` | 质量门槛后原子替换；离线 V1→V2 迁移 |
| 前端 | `src/App.tsx` | 今日必知、重要进展、持续关注、分类深读、搜索、偏好与三级 fallback |

## 关键契约

### 报告

- `DailyNewsReport.version` 固定为 `2`。
- `stories` 是所有正式事件的规范集合。
- `topStories`、`importantStories`、`watchlist` 是首页子集，同一事件不能跨层重复。
- `sections.storyIds` 必须全部能在 `stories` 中解析。
- `items` 是迁移期兼容字段，仍包含 `score_breakdown`、`trust`、`primaryCategory` 等 V1 消费字段。

### 事件选择

- `must_know` 由独立公共影响模型决定，不能使用个人偏好加分。
- 用户偏好只调整 `importantStories` 和分类深读顺序。
- 单一社交线索只能进入 `unverified`/watchlist，不能进入核心层。
- 体育和娱乐可作为 `special_interest` 保留在分类页，但时效与信源数量不能单独把预测/评论推入 must-know。
- 没有合格事件的栏目允许为空，并显示明确空状态；禁止用 noise 填数。

### 抓取与可靠性

- 整轮默认预算为 `DAILY_NEWS_COLLECTION_BUDGET_MS=30000`。
- Firecrawl 最多使用前 8 秒；候选少于 `max(8, maxSources)` 时继续直连并合并。
- 直连来源并发默认 `DAILY_NEWS_SOURCE_CONCURRENCY=6`；单请求最长 8 秒且受整轮 deadline 约束。
- 新报告若丢失已覆盖核心 beat 的全部候选，或事件/核心层/来源数量严重回退，不能替换 last-known-good。
- `GET /api/news` 不允许触发外部抓取。

### 安全

- 浏览器不得读取 Firecrawl、翻译或刷新凭据。
- Vercel 的 `POST /api/refresh` 需要 `DAILY_NEWS_REFRESH_TOKEN`；未配置返回 `503`，错误凭据返回 `401`。
- 不绕过登录、付费墙或访客验证；只保存公开标题、摘要、时间、URL 和最小证据元数据。

## 前端状态流

```text
/api/news V2
  -> /daily-news.json（V2；V1 会在浏览器升级）
  -> firecrawlSnapshotNews
```

- 首页今日必知顺序不受偏好影响。
- 重要进展和分类页用兼容 item 的个性化分数重排对应 `StoryCard`。
- 搜索作用于事件标题、发生了什么、重要性解释、来源、beat 和 event type。
- 分类页直接渲染 `stories`，不重新生成文章卡片。

## 仍未完成

- 7–14 天人工 golden dataset 与 must-know 召回/精确率校准；
- 连续 7 天 shadow 对比和生产灰度；
- 外部生产 `NewsStore`、候选/事件历史表、来源健康持久化和历史日报 API；
- 生产调度器、日志聚合、告警和真实 P95 dashboard；
- 人工事件合并/拆分和更正后台。

## 验收

- `npm test`；
- `npm run build`；
- `npm run upgrade-report` 后验证 section/story/item 引用完整；
- `curl /api/news` 返回 V2 且读取路径不访问外部网络；
- 浏览器检查桌面和 390px：三层首页、分类引用、空分类、搜索、设置、fallback 与控制台。
