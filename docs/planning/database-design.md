# 新闻事件与日报持久状态设计

## 文档目的

定义新闻来源与选题重构所需的逻辑持久状态，使采集任务、事件聚类、持续更新、last-known-good 报告和质量审计不再依赖单个进程内存。

本文定义逻辑实体、生命周期和一致性要求，不锁定数据库供应商。生产存储供应商、连接方式和成本边界均为 `待确认`。

当前实现状态：`scripts/reportStore.ts` 已实现 bundled JSON + 内存 latest pointer、V1→V2 升级和发布质量门槛；`DailyNewsReportV2` 已把事件与 evidence 持久化在静态报告中。候选、来源健康、运行历史和多版本报告尚未接入外部数据库，因此本文其余实体仍是下一阶段逻辑设计，不应当作已部署表结构。

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
- 不在规划阶段决定 PostgreSQL、SQLite、KV、Blob 或其他供应商。

## 逻辑实体

### `source_state`

记录来源配置的运行状态，不复制代码中的完整来源定义。

| 字段 | 含义 |
| --- | --- |
| `source_id` | 对应来源注册表的稳定 ID |
| `last_attempt_at` | 最近一次采集尝试 |
| `last_success_at` | 最近一次成功 |
| `consecutive_failures` | 连续失败次数 |
| `circuit_open_until` | 熔断截止时间 |
| `latency_ms_p50/p95` | 滚动延迟指标 |
| `accepted_rate` | 候选通过质量门槛的比例 |
| `last_error_code` | 归一化错误类型，不保存敏感错误正文 |

### `article_candidate`

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

### `selection_run`

记录一次选题运行及其可复现输入输出。

| 字段 | 含义 |
| --- | --- |
| `run_id` | 运行 ID |
| `pipeline_version` | V1/V2 或具体版本 |
| `window_from/to` | 候选时间窗口 |
| `started_at/finished_at` | 耗时 |
| `input_candidate_count` / `event_count` | 规模 |
| `filter_counts` | 各拒绝原因数量 |
| `quality_metrics` | 覆盖、重复、来源集中度等 |
| `status` | passed/rejected/failed |
| `rejection_reasons` | 未发布原因 |

### `report_snapshot`

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

## 索引和约束

- `article_candidate(canonical_url, source_id)` 唯一；
- `article_candidate(published_at)` 支持时间窗口扫描；
- `story_event(last_updated_at, status)` 支持持续事件更新；
- `story_event(primary_beat, importance_tier)` 支持选题和覆盖检查；
- `story_evidence(event_id)` 和 `story_evidence(candidate_id)` 支持双向追溯；
- `report_snapshot(generated_at)` 支持回滚和历史报告；
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

1. Phase 0–2 使用 shadow store，不改变 V1 报告；
2. 从现有 `public/daily-news.json` 导入一份只读基准 snapshot，不把它伪装为候选源数据；
3. V2 事件和报告使用独立 schema/version；
4. V2 API 通过兼容 `items` 字段服务旧前端；
5. 回滚只需把 latest pointer 切回最后一个 V1/兼容报告，并停止 V2 调度；
6. 删除 V1 结构前必须确认观察期内无消费者依赖。

## 验收标准

- API 冷启动可读取 last-known-good 报告；
- 同一候选重复采集不会产生重复记录；
- 同一事件可跨刷新追加 evidence；
- 质量失败的运行不会替换 latest；
- 任一已发布事件可追溯到具体来源 URL；
- 报告可回滚到上一成功版本；
- 保留数据不含 secret、Cookie、完整付费墙正文或用户身份信息。

## 待确认

| 项 | 影响 |
| --- | --- |
| 生产存储供应商 | Serverless 兼容、成本、事务和运维 |
| 是否需要用户可见历史日报 | 报告保留期和 API/UI 范围 |
| 是否保存短期正文片段 | 摘要可复现性、版权和存储成本 |
| 事件人工纠错入口 | 聚类纠错和审计流程 |
| 数据迁移工具 | 取决于最终供应商和是否保留 V1 历史 |
