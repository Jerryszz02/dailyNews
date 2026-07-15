# Daily News 技术设计

## 文档目的

记录当前事件级 V2 的实现契约。修改来源、采集、选题、API、静态报告或前端时，应以本文和 [news-curation-refactor-plan.md](news-curation-refactor-plan.md) 的实施状态为准。

## 当前架构

```text
src/config/sources.ts
  -> src/lib/sourceCoverage.ts
  -> Firecrawl keyless（默认约 4 秒，最多 8 秒）+ 有限并发 direct fetch
  -> 72 小时候选池、12 秒采集截止与 30 秒整轮目标
  -> src/lib/curation.ts 质量门槛
  -> src/lib/dedupe.ts 事件聚类
  -> evidence / status / public impact / tier / diversity
  -> DailyNewsReport V2
  -> scripts/reportStore.ts 发布门槛与 last-known-good
  -> GET /api/news 只读
  -> src/App.tsx 事件级首页与分类引用
```

迁移前基线只能在单个常驻 Node 进程中定时刷新；Vercel Functions 的内存缓存和定时器不构成生产持久状态，生产 `/api/news` 只能读 bundled/单实例内存，刷新失败后旧内容还可能被重新包装成新的 `generatedAt`。这就是网页曾连续两三天不更新、手动刷新无效的主要原因；下述 Supabase Phase 2 已替换这条生产运行链路。

## Phase 2 目标架构（Supabase）

```text
15 分钟外部调度器
  -> GET /api/cron（CRON_SECRET）
  -> Supabase RPC 获取刷新租约
  -> 按 next_due_at 公平选择本轮来源
  -> Firecrawl keyless + direct fetch
  -> upsert 公开候选和来源结果
  -> 读取 Supabase 最近 72 小时候选
  -> V2 质量门槛、事件聚类和选题
  -> Supabase RPC 原子写 snapshot + 切换 latest
  -> GET /api/news / GET /api/health 只读 durable state
  -> 浏览器每 30 秒用共享时间桶检查报告状态
```

关键决定：

- Supabase 是唯一生产运行态来源；`public/daily-news.json` 只保留为部署包内的紧急 last-known-good。
- 生产调度由 Supabase Cron 每 15 分钟通过 `pg_net` 调用受保护 endpoint，不能依赖 Vercel 套餐频率或函数内 `setInterval`。
- 每轮只采集预算内的一部分来源，但选择顺序由持久化 `next_due_at` 决定；调度槽、幂等键和报告时间使用请求入口捕获的 `scheduledAt`，due/circuit 资格则使用状态读取完成后的 `max(scheduledAt, wall-clock now)`，避免 setup 期间跨过到期边界而漏选；正常健康状态下 49 个已启用来源必须在滚动 90 分钟内全部尝试，circuit-open 来源在两个 interval 后半开重试。
- 候选按 canonical URL 幂等写入，报告从最近 72 小时候选池构建，使分片采集不会只看到本轮少数来源。
- 旧 bundled/snapshot 只能原样返回。无合格实时数据时不得以当前时间重写 `generatedAt`、`last_success_at` 或内容新鲜度。
- 发布由事务 RPC 完成；刷新失败只更新 `last_attempt_at` 和非敏感错误码，不动 latest。

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

Phase 2 新增职责：

| 子系统 | 目标职责 |
| --- | --- |
| Supabase NewsStore | 候选、来源状态、刷新运行、租约、不可变快照和 latest pointer |
| 公平调度 | 以持久 `next_due_at` 选择来源；失败退避但不永久饿死来源 |
| Cron 入口 | GET、secret 鉴权、幂等获取租约；不向调用方返回内部错误或凭据 |
| Durable API | 冷实例读取同一 latest，按 durable 时间计算 fresh/stale/degraded/unavailable |
| 前端新鲜度 | 显示“内容更新时间”和“页面检查时间”两个不同概念；stale 时给明确警告 |

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

- 采集阶段默认预算为 `DAILY_NEWS_COLLECTION_BUDGET_MS=12000`，为只读重试、冷启动、持久化、聚类和发布预留时间，使整轮目标保持在 30 秒内。
- 默认预算下 Firecrawl 使用前约 4 秒且绝不超过 8 秒；候选少于 `max(8, maxSources)` 时继续直连并合并。
- 直连来源并发默认 `DAILY_NEWS_SOURCE_CONCURRENCY=8`；单请求最长 8 秒且受整轮 deadline 约束。
- deadline 前尚未真正发起请求的来源不写入 `source_state`，保留 due 状态并在下个时槽继续优先，不能误计失败或触发熔断。
- 新报告若丢失已覆盖核心 beat 的全部候选，或事件/核心层/来源数量严重回退，不能替换 last-known-good。
- `GET /api/news` 不允许触发外部抓取。
- `generatedAt` 只表示该报告成功发布的时间；`newestContentAt` 表示报告中最新新闻时间；浏览器 `lastLoadedAt` 只表示客户端检查时间，三者不得互相替代。
- Supabase 不可用时可返回 bundled last-known-good，但必须保持原时间并将 refresh status 标为 `degraded` 或 `stale`。
- 同一调度请求重试、并发调用和函数超时必须由数据库租约与幂等 run ID 收敛为至多一次发布。

### 安全

- 浏览器不得读取 Firecrawl、翻译或刷新凭据。
- Vercel 的 `POST /api/refresh` 需要 `DAILY_NEWS_REFRESH_TOKEN`；未配置返回 `503`，错误凭据返回 `401`。
- 不绕过登录、付费墙或访客验证；只保存公开标题、摘要、时间、URL 和最小证据元数据。
- `SUPABASE_SECRET_KEY`、`CRON_SECRET` 和 `DAILY_NEWS_REFRESH_TOKEN` 只存在于服务端环境；前端只接收公开报告和聚合健康字段。

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

## Phase 2 上线门

- 迁移可在本地 clean database 重放，RLS 阻止 anon/authenticated 访问 server-only 表；
- 独立进程读取同一 latest，并发刷新只有一个有效租约；
- 失败/无实时数据不会发布，也不会刷新旧报告时间；
- 调度模拟证明所有启用来源在 90 分钟内被尝试；
- `/api/news` 和 `/api/health` 从 durable state 计算 freshness；报告超过 30 分钟时 API 与 UI 都明确 stale；
- 72 小时候选池用于跨轮次聚合；活动时间取 story/evidence 的最新有效时间。候选池与实际首页选择分别执行 120 分钟门，失败使用 `stale_candidate_pool` 或 `stale_homepage_selection` 并保留 last-known-good；
- 测试、构建、本地 Supabase 集成、生产部署 smoke 全部通过。

## Phase 2 运行门

- 先连续观察 24 小时，确认调度、跨实例可见性、来源轮转和 stale 告警；
- 再连续观察 7 天：调度成功率不低于 99%，报告年龄 P95 不高于 20 分钟，固定 30 秒 CDN 窗口的 API P95 不高于 750 ms、P99 不高于 1 秒；
- 运行门通过前只能称为“已上线观察”，不能称为实时更新目标最终验收完成。

## 仍未完成

- 7–14 天人工 golden dataset 与 must-know 召回/精确率校准；
- 连续 7 天 shadow 对比和生产灰度；
- 历史日报用户界面、独立事件/evidence 查询表和人工更正后台；
- 日志聚合、外部告警和真实 P95 dashboard；
- 人工事件合并/拆分和更正后台。

## 验收

- `npm test`；
- `npm run build`；
- `npm run upgrade-report` 后验证 section/story/item 引用完整；
- `curl /api/news` 返回 V2 且读取路径不访问外部网络；
- 浏览器检查桌面和 390px：三层首页、分类引用、空分类、搜索、设置、fallback 与控制台。
- Supabase clean reset/lint、远端 migration dry-run、跨实例/并发 store contract；
- 生产 cron smoke、冷实例 60 秒可见、30 分钟 stale 演练和来源 90 分钟轮转；
- 按 [test-plan.md](test-plan.md) 保存上线门与 24 小时/7 天运行门证据。
