# Daily News 测试计划

## 文档目的

定义 Daily News 后续改动的最小验证路径，确保新闻生成、排序、去重、可信度、API fallback 和前端体验没有回退。本文仅根据当前仓库可见内容整理；未在仓库中找到证据的内容均不做假设。

## 适用范围

适用于修改产品行为、数据生成、API、排序、去重、可信度、分类、前端展示、中文化或来源配置的工作。

Phase 2 同时适用于 Supabase 数据一致性、生产调度、跨实例、新鲜度、回滚和连续运行验收。长期 dashboard 仍是非目标，但必须保存 24 小时与 7 天观察证据。

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

当前实现已有 12 秒采集硬截止、30 秒整轮目标、来源并发上限、V2 `coverage`/`quality` 摘要和相对发布门槛，但仍没有生产监控 dashboard。可做的检查：

- `npm run generate` 不应因单个来源失败而整体失败；
- API 刷新时日志应能说明使用 `Firecrawl keyless`、`Direct source fetch` 或 `Firecrawl snapshot`；
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
- 页面残留重复事件率不高于 5%；`quality.duplicateEventRate` 是候选聚类压缩率，不能代替该指标；
- 错误来源归因和缺失发布时间均为 0；
- 通用模板摘要不高于 3%；
- 核心层至少 15 条时，`maxPrimaryPublisherShare` 不高于 20%；
- `singleIndependentSourceEventShare` 与 `weaklySourcedCoreShare` 作为事件内交叉证据观察指标，先建立 golden baseline，不与首页媒体多样性混用；
- 有合格候选的 beat 全部被覆盖；
- `GET /api/news` 固定 30 秒窗口的小流量基准 P95 不高于 750 ms、P99 不高于 1 秒；
- 单轮生成 P95 初始目标不高于 30 秒，最终阈值按 Phase 0 基准校准。

### Shadow 验收

V2 已成为本地、静态和生产默认结构，但 Phase 2 发布门与 7 天运行门尚未关闭。运行观察期间继续保留前后报告对照并人工比较：

- V2 是否遗漏 V1 中的高价值事件；
- V2 新增事件中有多少属于 noise；
- 事件聚类、来源证据和摘要是否可解释；
- 分类覆盖是否来自真实合格事件，而不是为了填数；
- V2 失败时 V1 或 last-known-good 是否仍可用。

Shadow 未达到量化门槛时，不进入默认切换阶段。

## Phase 2 Supabase 实时更新验收

本阶段分成两道门：

- **上线门**：确定性测试、数据库迁移、跨实例、调度、API/UI、安全、性能 smoke 全部通过后，才允许生产调度接管。
- **运行门**：上线后连续 24 小时无结构性故障，再连续 7 天满足 SLA；完成前只能报告“已上线观察”，不能宣称实时更新目标最终完成。

项目应固定 Supabase CLI 版本，并提供统一命令；本地具备 Docker 时执行 clean database，若本机没有 Docker，则必须在独立 staging Supabase 项目执行同等迁移和集成测试，不能用纯 mock 代替数据库事务证据。

```bash
npx supabase db reset
npx supabase test db
npm test
npm run test:integration
npm run build
```

### 上线门 A：Schema、权限和迁移

| ID | 验收 | 证据与阈值 |
| --- | --- | --- |
| A1 | 空库重放 | migration 从空库连续执行两次均成功，`supabase test db` 零失败 |
| A2 | 表与索引 | 来源状态、候选、refresh run、lease/runtime、snapshot、latest pointer 及必要唯一/时间索引存在 |
| A3 | 权限 | internal tables 全部启用 RLS；anon/authenticated 不能读写或执行刷新 RPC；server role 可执行 |
| A4 | 远端一致 | `db push --dry-run` 与 migration list 表明 local/remote 历史一致后才正式 push |
| A5 | secret 隔离 | 前端 bundle、公开 JSON、API 错误和 git tracked files 不含真实 Supabase/cron/翻译 secret |

### 上线门 B：持久化和原子性

| ID | 验收 | 证据与阈值 |
| --- | --- | --- |
| B1 | 候选幂等 | 同一 `(source_id, canonical_url)` 并发 upsert 20 次最终只有一条 |
| B2 | 刷新租约 | 10 个并发请求只有一个 acquired；过期租约可被新 owner 以更高 fencing token 接管 |
| B3 | 原子发布 | 快照写入、latest pointer、run 状态在同一事务完成；故意失败时三者全部不变 |
| B4 | stale worker | 旧 owner/fencing token 无法覆盖新 worker 发布的报告 |
| B5 | 无新内容 | 成功扫描可更新 `lastAttemptAt`/`lastSuccessAt`，但 `reportId` 和 `generatedAt` 不变 |
| B6 | 质量失败 | rejected/failed run 不切换 latest，不把 bundled/fallback 重新盖当前时间 |
| B7 | 回滚 | 可原子切回上一成功 snapshot，坏版本保留审计，API 在 60 秒内收敛 |

### 上线门 C：跨实例、候选池和来源轮转

| ID | 验收 | 证据与阈值 |
| --- | --- | --- |
| C1 | 真跨实例 | 进程 A 发布并退出后，独立冷进程 B 从同一 Supabase 读取相同 `reportId`；本地不超过 5 秒，生产不超过 60 秒 |
| C2 | 72 小时候选池 | A 轮采来源组 1、B 轮采来源组 2，B 报告输入同时含 A+B；超过 72 小时的候选被排除 |
| C3 | 注册表对齐 | 49 个 enabled source 都有持久 state；代码与数据库没有孤儿 source ID |
| C4 | 公平轮转 | 固定时钟模拟 15 分钟 cadence、每轮最多 10 源；正常健康状态下，滚动 90 分钟内所有 49 个 enabled source 都至少尝试一次 |
| C5 | 熔断恢复 | 连续 3 次失败的 circuit-open 来源不计入 C4 健康源窗口；两个 interval（默认 180 分钟）后重新进入 due 队列并半开重试，低权重来源不会永久饥饿 |
| C6 | 单源故障隔离 | 401/429/timeout/无结果被归一化记录，不影响其他来源候选落库，不保存完整外部响应 |

### 上线门 D：Freshness、API 和 UI

公开元数据至少包含 `reportId`、`dataAsOf`、`newestContentAt`、`lastAttemptAt`、`lastSuccessAt` 和 freshness status。

| ID | 验收 | 证据与阈值 |
| --- | --- | --- |
| D1 | fresh | 报告真实 `dataAsOf/generatedAt` 不超过 30 分钟且通过 D9 内容门；正常目标 P95 报告年龄不超过 20 分钟。`lastSuccessAt` 只表示最近成功检查，不可洗新报告 |
| D2 | stale | 报告真实 `dataAsOf/generatedAt` 超过 30 分钟时 `/api/news` 与 `/api/health` 都明确 stale；即使刚完成一次无新内容检查，新闻仍只返回原时间的 last-known-good |
| D3 | degraded | Supabase 失败但 bundled 可读时 news 返回 200 + degraded/stale；health 返回非健康状态，不伪装 fresh |
| D4 | unavailable | Supabase 与所有 fallback 均无报告时返回 503 + unavailable |
| D5 | 时间真实性 | UI 分别显示报告生成、最新新闻、上次成功检查；页面读取时间不能冒充内容更新时间 |
| D6 | 按钮语义 | 浏览器按钮只 GET `/api/news?view=web&reload=1`，浏览器响应为 `no-store`、边缘 TTL 为 5 秒，文案为“重新加载报告”，不从浏览器触发采集 |
| D7 | 自动收敛 | 前端每 30 秒请求共享 compact `view=web&window` URL；API 从报告 A 变为 B 后，已打开页面在 60 秒内显示 B |
| D8 | 响应式 | 桌面与 390px 下 stale banner、时间状态和报告内容无关键遮挡，新增文案为中文 |
| D9 | 内容发布门 | 候选活动时间取 `updatedAt`、`publishedAt`、evidence `publishedAt` 的最大值；候选池最新活动超过 120 分钟记 `stale_candidate_pool`，首页实际选择最新活动超过 120 分钟记 `stale_homepage_selection`。有 fresh confirmed 核心候选时 top/important 至少选中一条；任何失败都保留 last-known-good 的 `reportId`/`dataAsOf` |

### 上线门 E：调度、性能和生产 smoke

| ID | 验收 | 证据与阈值 |
| --- | --- | --- |
| E1 | 真实调度 | Supabase Cron 每 15 分钟经 `pg_net` 调用受保护 GET；不是函数内定时器，也不是只展示 interval 字段 |
| E2 | 调度鉴权 | cron secret 未配置为 503，错误/缺失为 401，正确调用运行或明确返回 busy/skipped |
| E3 | 定时幂等 | 同一时间槽重试只产生一个有效 run 和至多一个 snapshot |
| E4 | latest read | production 网页 compact `/api/news?view=web&window=...` 使用 30 秒 Vercel 边缘缓存；固定窗口、并发 5 的 100 请求样本 P95 不高于 750 ms、P99 不高于 1 秒、错误率为 0。`view=web&reload=1` 必须浏览器 `no-store` 且边缘 TTL 5 秒；非法 cache query 必须在 durable read 前返回 `400 + no-store`。阈值基于中国访问 iad1 与约 33 KB gzip payload 的实测校准 |
| E5 | 单轮预算 | refresh run P95 不高于 30 秒；超时必须释放或允许 lease 到期且不发布半成品 |
| E6 | 生产 smoke | migration、bootstrap、手动两轮刷新、冷实例读取、stale 演练、回滚演练全部留下时间戳与 report ID 证据 |

### 运行门 F：24 小时与 7 天

| 阶段 | 通过标准 |
| --- | --- |
| 24 小时 burn-in | 无双 latest、无候选丢失、成功检查最大间隔不超过 30 分钟、49 源轮转达标、无 secret/内部错误泄漏 |
| 7 天生产 soak | 调度成功率不低于 99%；报告年龄 P95 不高于 20 分钟；冷实例 latest 收敛不超过 60 秒；healthy 来源 cadence 达标率 100% |
| 内容延迟抽样 | 重大来源新闻发布到网站可见 P95 不高于 30 分钟；一般新闻 P95 不高于 2 小时 |
| 内容质量 | must-know 召回不低于 90%、首页价值精确率不低于 85%、重复事件不高于 5%、模板摘要不高于 3%、错误来源归因和缺失发布时间为 0 |

运行证据至少保留每个 refresh run 的时间槽、状态、已选来源、发现/采用数量、published report ID 和归一化错误码；HTTP 200 本身不能作为调度成功证据。

## 非目标

- 不要求端到端自动化浏览器测试，当前仓库没有 Playwright/Cypress 配置。
- 不要求大规模容量压测；但 Phase 2 必须完成上述 latest read 小流量性能 smoke。
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
| 是否把确定性验收接入 CI | 本轮先保证命令可重复执行；CI 平台和 secret scope 可在上线前确认 |
| 浏览器自动化工具 | 若不新增 Playwright，则桌面/390px 与 stale/fallback 必须保存人工验收证据 |
| 7 天观察的告警渠道 | 指标阈值已定义，但通知渠道仍需结合现有账号与成本确认 |
