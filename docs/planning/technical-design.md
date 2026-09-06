# Daily News 技术设计

## 文档目的

记录当前事件级 V2 的实现契约。修改来源、采集、选题、API、静态报告或前端时，应以本文和 [news-curation-refactor-plan.md](news-curation-refactor-plan.md) 的实施状态为准。

## 2026-08-10 目标不变量

1. `approved` 是来源发布边界，`enabled` 只控制是否采集；运行时 trust/credibility 不得删除或降出可见集合。
2. 每个 `display_ready/degraded` 候选恰好映射一个 story；最近 24 小时 story 全部进入 `latestStories`。
3. 每 2 小时刷新一次，全部启用且已准入来源进入同一轮计划；默认并发 24，局部失败返回 partial，但健康状态不能把来源从下一轮计划中排除。
4. 发布只阻断结构损坏、引用错误、未知来源和不可确认的存储失败；精选、内容年龄和覆盖波动只产生 warning。
5. `/api/news` 读取 publication state，不依赖 source state；服务、管线、内容状态分轴公开。

## 当前架构

```text
src/config/sources.ts
  -> src/lib/sourceCoverage.ts 全来源计划
  -> Firecrawl keyless + 有限并发 direct fetch（默认并发 24，单来源最多 8 秒）
  -> 45 秒采集预算内维护 72 小时候选池
  -> src/lib/curation.ts 结构准入门槛
  -> src/lib/dedupe.ts 确定性事件聚类
  -> 可选的限额 LLM 灰区关系判断
  -> evidence / status / public impact / tier / heat / diversity / daily edition
  -> DailyNewsReport V2
  -> scripts/newsRefresh.ts + NewsStore 发布门槛与 last-known-good
  -> Supabase 原子提交（本地无 Supabase 时使用 InMemoryNewsStore）
  -> GET /api/news 只读
  -> src/App.tsx 事件级首页与分类引用
```

生产运行链路已由 Supabase 取代早期 bundled JSON + 单进程内存刷新。旧架构只作为迁移动机保留在 Git 历史和生产验收记录中，不再是当前实现。

## 仓库定义的生产架构（Supabase）

```text
2 小时外部调度器
  -> GET /api/cron（CRON_SECRET）
  -> Supabase RPC 获取刷新租约
  -> 全部 enabled + approved 来源进入本轮计划
  -> Firecrawl keyless + direct fetch
  -> 读取 Supabase 最近 72 小时候选
  -> 合并原文候选、补译状态、事件聚类和选题
  -> Supabase V2 RPC 原子写来源结果、候选、可选 snapshot + latest
  -> GET /api/news / GET /api/health 只读 durable state
  -> 浏览器每 30 秒读取共享 CDN URL，主动重载使用 no-store
```

关键决定：

- Supabase 是唯一生产运行态来源；`public/daily-news.json` 只保留为部署包内的紧急 last-known-good。
- 生产调度由 Supabase Cron 每 2 小时通过 `pg_net` 调用受保护 endpoint，不能依赖 Vercel 套餐频率或函数内 `setInterval`。
- 每轮计划全部启用且已准入来源；默认 24 并发使当前 49 源可在同一 45 秒采集预算内分批开始。`next_due_at` 和失败状态继续用于诊断，不再用于跨刷新轮转。
- 候选按 canonical URL 幂等写入，报告从最近 72 小时候选池构建，使分片采集不会只看到本轮少数来源。
- 旧 bundled/snapshot 只能原样返回。无合格实时数据时不得以当前时间重写 `generatedAt`、`last_success_at` 或内容新鲜度。
- 发布由事务 RPC 完成；刷新失败只更新 `last_attempt_at` 和非敏感错误码，不动 latest。

## 子系统职责

| 子系统 | 文件 | 当前职责 |
| --- | --- | --- |
| 来源注册表 | `src/config/sources.ts` | 来源、栏目、查询词、主分类、admission、允许域名、审核说明和技术启用状态 |
| 覆盖调度 | `src/lib/sourceCoverage.ts` | 生产全来源计划；保留受限手动生成的兼容选择逻辑 |
| 采集服务 | `scripts/newsService.ts` | Firecrawl/直连、中文化、发布时间、域名归因、并发、总预算、新鲜度和 fallback |
| 候选门槛 | `src/lib/curation.ts` | 只拒绝未知/越域来源、非法身份、导航和推广；翻译/摘要/日期不足进入 degraded |
| 事件聚类 | `src/lib/dedupe.ts`, `scripts/semanticDedupe.ts` | canonical URL 与高相似度本地聚类；仅新候选灰区可选调用 LLM，`same_event` 且置信度至少 0.8 才写入持久语义锚点 |
| 信任与兼容排序 | `src/lib/trust.ts`, `src/lib/scoring.ts` | `shouldShow` 仅为兼容字段，不参与收录、tier 或排序；`trust.level` 参与事实状态判断，状态可影响持续关注层选择 |
| 事件选题 | `src/lib/curation.ts` | evidence、来源角色、status、公共影响、精选理由、独立热点、四级 tier、多样性和 08:00 全分类日报 |
| 报告管线 | `src/lib/newsPipeline.ts` | 输出 V2 `stories`、首页三层、sections、coverage、quality 和兼容 `items` |
| 报告存储 | `scripts/newsStoreFactory.ts`, `scripts/supabaseNewsStore.ts`, `scripts/inMemoryNewsStore.ts`, `scripts/reportStore.ts` | 生产 durable state、本地内存适配、bundled 读取、V1→V2 升级和发布门槛 |
| API | `scripts/newsApi.ts`, `scripts/newsServer.ts` | 只读 `/api/news`、健康状态、受保护刷新和静态服务 |
| 静态发布 | `scripts/generateDailyNews.ts`, `scripts/upgradeDailyNewsReport.ts` | 质量门槛后原子替换；离线 V1→V2 迁移 |
| 前端 | `src/App.tsx` | 今日必知、重要进展、持续关注、分类深读、搜索、偏好与三级 fallback |

持久运行职责：

| 子系统 | 当前职责 |
| --- | --- |
| Supabase NewsStore | 候选、来源状态、刷新运行、租约、不可变快照和 latest pointer |
| 全来源调度 | 每轮覆盖完整来源注册表；来源健康字段只做诊断，不推迟下一轮发现 |
| Cron 入口 | GET、secret 鉴权、幂等获取租约；不向调用方返回内部错误或凭据 |
| Durable API | 冷实例读取同一 latest，按 durable 时间计算 fresh/stale/degraded/unavailable |
| 前端新鲜度 | 显示“内容更新时间”和“页面检查时间”两个不同概念；stale 时给明确警告 |
| 历史生产验收 | 本地只读 monitor 保存固定 deployment 的历史证据；正式 burn-in/soak 已取消，未获明确批准不得恢复或拼接旧窗口 |

## 关键契约

### 报告

- `DailyNewsReport.version` 固定为 `2`。
- `stories` 是所有结构有效事件的规范集合，包括低影响和 enrichment 待补事件。
- `latestStories` 是最近 24 小时 story 引用，按 `updatedAt` 降序；24 小时为空时回退到 72 小时最新内容。
- `topStories`、`importantStories`、`watchlist` 是首页子集，同一事件不能跨层重复。
- `sections.storyIds` 必须全部能在 `stories` 中解析。
- `items` 是迁移期兼容字段，仍包含 `score_breakdown`、`trust`、`primaryCategory` 等 V1 消费字段。
- `hotStories` 是 48 小时内按证据角色、独立来源增速和 24 小时半衰期计算的热点子集；热度不改变重要性层级。
- `dailyEdition` 固定以上海时间 08:00 为截止点，保存前 24 小时事件的独立 `stories` 卡片快照并按现有十类分组；同一 edition ID 已成功发布后，后续刷新保留原选择和正文，即使实时事件已更新或移出候选池。旧版日报首次沿用时从旧报告补齐卡片快照。

### 事件选择

- `must_know` 由独立公共影响模型决定，不能使用个人偏好加分。
- 用户偏好只调整 `importantStories` 和分类深读顺序。
- 单一社交线索显示为 `unverified`，但仍进入 stories/latest；状态不决定可见性。
- 体育和娱乐可作为 `special_interest` 保留在分类页，但时效与信源数量不能单独把预测/评论推入 must-know。
- 精选栏目可以为空；完整 stories/latest 不能因 tier、来源或 beat 配额丢事件。

### 抓取与可靠性

- 采集阶段默认预算为 `DAILY_NEWS_COLLECTION_BUDGET_MS=45000`；60 秒函数上限中至少预留 10 秒用于构建、验证和原子终结。
- Firecrawl 与 direct fetch 按来源独立截止并发运行；一个来源的 terminal/timeout 不能跳过其它已选来源。
- 直连和 Firecrawl 来源 worker 默认 `DAILY_NEWS_SOURCE_CONCURRENCY=24`；当前 49 源分最多三批进入 worker，单来源最长 8 秒且受整轮 deadline 约束。
- deadline 前未完成的来源标记 partial/failed/skipped；错误/circuit 诊断不得把它从下一个全来源计划中移除。
- LLM 去重必须显式开启，复用服务端翻译供应商配置；每条新候选最多 3 个近邻、每轮默认最多 12 次调用、总处理窗口 4 秒，失败保守不合并。
- 事件/核心层/来源数量回退只记 warning；完整候选窗口下的合法变化可发布，窗口不完整时只增不减并保留 last-known-good 内容。
- `GET /api/news` 不允许触发外部抓取。
- `generatedAt` 只表示该报告成功发布的时间；`newestContentAt` 表示报告中最新新闻时间；浏览器 `lastLoadedAt` 只表示客户端检查时间，三者不得互相替代。
- Supabase 不可用时可返回 bundled last-known-good，但必须保持原时间并将 refresh status 标为 `degraded` 或 `stale`。
- 同一调度请求重试、并发调用和函数超时必须由数据库租约与幂等 run ID 收敛为至多一次发布。

### 安全

- 浏览器不得读取 Firecrawl、翻译或刷新凭据。
- Vercel 和任何 persistent store 的 `POST /api/refresh` 都需要 `DAILY_NEWS_REFRESH_TOKEN`；未配置返回 `503`，错误凭据返回 `401`。仅本地 in-memory store 保留显式同源开发例外，并要求 `X-Daily-News-Refresh: 1`。
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

## 完整性优先上线门

- 迁移可在本地 clean database 重放，RLS 阻止 anon/authenticated 访问 server-only 表；
- 独立进程读取同一 latest，并发刷新只有一个有效租约；
- 失败/无实时数据不会发布，也不会刷新旧报告时间；
- 调度测试证明默认刷新计划精确等于全部启用且已准入来源，健康/due 状态不影响计划成员；
- `/api/news` 和 `/api/health` 分别计算 serving、pipeline 和 content status；有可读报告时 stale/quiet 仍返回 200；
- 72 小时候选池按来源分页完整读取；每个有效候选恰好映射 story，最近 24 小时 story 全部进入 latest；不再存在 `stale_candidate_pool`/`stale_homepage_selection` 发布硬门；
- 测试、构建、本地 Supabase 集成、生产部署 smoke 全部通过。

## Phase 2 历史运行门（已取消）

- 原方案先连续观察 24 小时，再连续观察 7 天；其五分钟 cadence、滚动覆盖和报告年龄阈值不适用于当前两小时成本控制模式。
- 当前不要求完成该运行门；若未来重新启用，必须按全来源 sweep 重新定义调度成功率、内容年龄、来源覆盖和 API 延迟阈值，并以独立新窗口验收。

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
- 生产 cron smoke、冷实例 60 秒可见、分轴 stale 演练和全来源计划核对；
- 按 [test-plan.md](test-plan.md) 保存上线门证据；24 小时/7 天运行门只有在未来明确批准并重新设计后才执行。
