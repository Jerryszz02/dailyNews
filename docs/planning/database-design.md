# 新闻事件与日报持久状态设计

## 文档目的

定义新闻来源与选题重构所需的逻辑持久状态，使采集任务、事件聚类、持续更新、last-known-good 报告和质量审计不再依赖单个进程内存。

本文定义逻辑实体、生命周期和一致性要求，并选定 Supabase 托管 PostgreSQL 作为 Phase 2 的生产持久层。数据库结构只通过 `supabase/migrations/` 迁移文件维护；服务端使用 Supabase secret key，浏览器不直连这些表。

实施前基线：`scripts/reportStore.ts` 只有 bundled JSON + 单进程内存 latest pointer，Serverless 实例之间不能共享刷新结果；`DailyNewsReportV2` 只把事件与 evidence 保存在静态报告中。目标状态是由 Supabase 持久化来源调度、候选、刷新运行、不可变报告和 runtime pointer，API 冷启动也能读取同一个 last-known-good。

## 适用范围

适用于 [news-curation-refactor-plan.md](news-curation-refactor-plan.md) 中 Phase 2–5 的候选、事件、证据、来源健康、选题运行和日报快照。

不适用于用户账号、用户偏好、行为分析、评论、收藏或全文新闻归档。用户偏好继续保存在浏览器本地，除非未来另行立项。

## Plan 或项目证据

| 证据 | 设计影响 |
| --- | --- |
| 当前 `scripts/newsServer.ts` 只使用内存缓存 | 重启或 Serverless 实例变化后无法保留上次成功报告 |
| 当前 `public/daily-news.json` 是生成产物 | 不能作为并发更新的运行时数据库 |
| 新计划需要跨刷新事件聚类和持续更新 | 需要稳定的事件 ID、证据关系和更新时间 |
| 新计划要求抓取与用户请求解耦 | 采集任务和只读 API 必须通过持久 snapshot 交换结果 |
| 新计划要求可回滚和质量门槛 | 需要不可变报告版本和原子 latest 指针 |

## 非目标

- 不保存付费墙正文、登录后内容或完整转载文章。
- 不保存 secret、Cookie、请求头或翻译服务凭据。
- 不引入用户身份数据。
- 不开放 Supabase Auth、用户表或浏览器端数据库访问；本阶段所有数据库操作均为服务端运行时操作。
- 不把 Supabase 当作全文新闻归档、内容管理后台或用户行为数据库。

## 逻辑实体

### `daily_news.source_state`

记录来源配置的运行状态，不复制代码中的完整来源定义。

| 字段 | 含义 |
| --- | --- |
| `source_id` | 对应来源注册表的稳定 ID |
| `last_attempt_at` | 最近一次采集尝试 |
| `last_success_at` | 最近一次成功 |
| `next_due_at` | 持久化公平轮转游标；到期来源优先被下一轮选择 |
| `consecutive_failures` | 连续失败次数 |
| `circuit_open_until` | 熔断截止时间 |
| `latency_ms_p50/p95` | 滚动延迟指标 |
| `accepted_rate` | 候选通过质量门槛的比例 |
| `last_error_code` | 归一化错误类型，不保存敏感错误正文 |

### `daily_news.article_candidate`

保存公开文章的最小可审计元数据。

| 字段 | 含义 |
| --- | --- |
| `candidate_id` | 稳定 ID |
| `canonical_url` | 去参数后的唯一 URL |
| `source_id` | 来源 ID |
| `title` | 原始或可靠清洗后的标题 |
| `published_at` / `updated_at` / `discovered_at` | 三种时间语义 |
| `language` | 原文语言，仅用于处理 |
| `content_fingerprint` | 去重摘要，不保存整篇正文 |
| `extracted_facts` | 结构化事实 JSON，保留字段级来源 |
| `quality_status` | accepted/rejected/pending |
| `rejection_reasons` | 归一化拒绝原因数组 |

唯一约束：`canonical_url + source_id`。同一 URL 的更新时间变化应更新候选版本，而不是无限新增重复记录。

### `story_event`

表示一个现实事件，而不是一篇文章。

| 字段 | 含义 |
| --- | --- |
| `event_id` | 稳定事件 ID |
| `primary_beat` | 唯一主领域 |
| `scope` | 地理影响范围 |
| `event_type` | 政策、灾害、财报等类型 |
| `status` | confirmed/developing/disputed/corrected/unverified |
| `importance_tier` | must_know/important/special_interest/noise |
| `first_seen_at` / `last_updated_at` | 生命周期 |
| `entities` / `topics` | 聚类和跟踪实体 |
| `impact_features` | 重要性特征，不只保存最终分数 |
| `cluster_explanation` | 为什么这些候选属于同一事件 |

### `story_evidence`

连接事件与候选，记录证据独立性和用途。

| 字段 | 含义 |
| --- | --- |
| `event_id` / `candidate_id` | 关系主键 |
| `evidence_role` | original/confirmation/context/analysis/lead |
| `independence_group` | 判断多个来源是否来自同一通稿 |
| `supports_claims` | 支持的结构化事实 ID |
| `conflicts_with_claims` | 冲突事实 ID |
| `added_at` | 加入事件时间 |

### `daily_news.refresh_run`

记录一次选题运行及其可复现输入输出。

| 字段 | 含义 |
| --- | --- |
| `run_id` | 运行 ID |
| `trigger` / `pipeline_version` | cron/manual/local 与具体管线版本 |
| `window_from/to` | 候选时间窗口 |
| `started_at/finished_at` | 耗时 |
| `input_candidate_count` / `event_count` | 规模 |
| `filter_counts` | 各拒绝原因数量 |
| `quality_metrics` | 覆盖、重复、来源集中度等 |
| `status` | running/published/rejected/failed |
| `rejection_reasons` | 未发布原因 |

### `daily_news.report_snapshot`

保存不可变的日报版本。

| 字段 | 含义 |
| --- | --- |
| `report_id` | 报告版本 ID |
| `run_id` | 生成它的选题运行 |
| `generated_at` | 生成时间 |
| `schema_version` | API/JSON 版本 |
| `payload` | `DailyNewsReportV2` |
| `is_latest` 或独立 latest pointer | 当前对外版本 |
| `supersedes_report_id` | 上一版本 |

报告必须先写入并验证完整，再通过原子操作切换 latest。失败运行不能覆盖上次成功报告。

### `daily_news.runtime_state`

单行运行时状态，承担跨实例协调和 latest pointer。

| 字段 | 含义 |
| --- | --- |
| `singleton_id` | 固定主键，防止出现多个 active runtime |
| `latest_report_id` | 当前 last-known-good，不得指向未完成快照 |
| `last_attempt_at` / `last_success_at` | 持久化健康语义，不依赖函数进程 |
| `active_run_id` / `lease_expires_at` | 刷新租约；并发或重复调度只能有一个拥有者 |
| `last_error_code` | 归一化最近错误，不保存敏感正文 |

数据库函数负责三项原子操作：`daily_news_try_start_refresh` 获取带过期时间的租约，`daily_news_publish_refresh` 在同一事务写入快照并切换 latest，`daily_news_fail_refresh` 结束失败运行但保留旧 latest。函数只授权服务端角色执行。

## 索引和约束

- `daily_news.article_candidate(canonical_url, source_id)` 唯一；
- `daily_news.article_candidate(published_at)` 支持 72 小时窗口扫描；
- `story_event(last_updated_at, status)` 支持持续事件更新；
- `story_event(primary_beat, importance_tier)` 支持选题和覆盖检查；
- `story_evidence(event_id)` 和 `story_evidence(candidate_id)` 支持双向追溯；
- `daily_news.source_state(next_due_at, last_attempt_at)` 支持公平轮转；
- `daily_news.report_snapshot(generated_at)` 支持回滚和历史报告；
- `daily_news.runtime_state` 只允许一行；
- latest report 切换必须具备原子性；
- 删除候选前必须保证已发布报告仍保留必要的来源 URL 和归因信息。

## 数据生命周期

建议初始保留期，实施前需按成本和用户回看需求确认：

| 数据 | 建议保留 |
| --- | ---: |
| 被拒候选 | 7 天 |
| 被采用候选及 evidence | 30 天 |
| 事件 | 最后更新后 90 天 |
| 报告快照 | 30 天 |
| 来源健康聚合 | 90 天 |
| 原始 HTML | 默认不持久保存 |

清理任务必须保留报告中面向用户的来源 URL、标题、归因和必要事实，不得导致历史报告失去解释能力。

## 一致性和失败处理

- 采集候选可重复执行，写入必须幂等；
- 聚类更新需要版本或事务，避免并发任务把同一候选放入多个活动事件；
- 选题运行读取一个稳定时间窗口，不在发布中途混入新候选；
- 报告 snapshot 不可原地修改，更正通过新版本替代；
- 数据库不可用时 API 继续返回内存或静态 last-known-good；
- 写入失败、质量门槛失败或摘要校验失败都不能切换 latest；
- 所有错误日志必须使用归一化代码，不记录 secret 或完整外部响应。

## 迁移和回滚

1. 在 `supabase/migrations/` 新增可重复审查的 SQL；先执行本地 reset/lint，再对目标项目执行 `db push --dry-run` 和 `db push`；
2. 从现有 `public/daily-news.json` 导入一份基准 snapshot，但保留它真实的 `generatedAt`，不把旧内容伪装成新候选；
3. 先以 shadow 模式写 Supabase，验证跨实例读取和原子发布，再让 `/api/news` 优先读取 Supabase；
4. 通过兼容 `items` 字段服务现有前端；失败时仍可退回 bundled last-known-good，但响应必须标记 stale/degraded；
5. 回滚时先停调度，再把 latest pointer 切回上一成功报告或恢复 bundled-first 读取；迁移只前向修复，不在生产执行破坏性 down migration；
6. 所有远端 schema 变更必须回写迁移文件，禁止 Dashboard 手工改表后不留版本记录。

## 验收标准

- 两个独立进程/Serverless 实例读取到同一个 `latest_report_id`；新报告发布后冷实例在 60 秒内可见；
- 同一候选重复采集不会产生重复记录；
- 同一事件可跨刷新追加 evidence，候选聚合窗口为最近 72 小时；
- 并发刷新最多一个取得有效租约，重复调度不产生双重发布；
- 质量失败、无合格实时候选或数据库写入失败都不会替换 latest，也不会改写 `last_success_at`；
- 快照 payload 与 latest pointer 在一个事务内切换，不允许读到半写入报告；
- 所有 enabled 且未熔断的健康来源在 15 分钟调度下滚动 90 分钟内都至少尝试一次；连续 3 次失败的来源熔断两个 interval，截止后自动半开重试；
- 正常运行时报告年龄 P95 不高于 20 分钟，超过 30 分钟必须标记 stale；
- `GET /api/news` 通过 30 秒 Vercel 时间桶缓存读取 latest，生产小流量 P95 不高于 750 ms、P99 不高于 1 秒；
- 任一已发布事件可追溯到具体来源 URL；
- 报告可回滚到上一成功版本；
- 所有表启用 RLS，anon/authenticated 无策略即不可访问；只有服务端 secret key 可执行持久化操作；
- 保留数据不含 secret、Cookie、完整付费墙正文或用户身份信息。

## 待确认

| 项 | 影响 |
| --- | --- |
| Supabase 生产项目与区域 | 需要项目 ref、数据库连接权限和运行环境变量；不得在文档或日志记录真实 secret |
| 是否需要用户可见历史日报 | 报告保留期和 API/UI 范围 |
| 是否保存短期正文片段 | 摘要可复现性、版权和存储成本 |
| 事件人工纠错入口 | 聚类纠错和审计流程 |
| 历史事件表何时从 JSON payload 拆表 | 当前实时更新只要求候选、运行和快照；独立事件/evidence 表可在确有查询需求时迁移 |
