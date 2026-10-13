# 数据库存储清单

2026-10-12 按当前代码和 migration 核对。旧云 Supabase 与新版独立 PostgreSQL 是两套数据库；下表的 schema 清单不等于两套服务都已上线。实测占用和实施状态见 [减量计划](planning/database-storage-reduction-plan.md)。

## 旧云 Supabase

业务数据位于 `daily_news` schema，共六张表。2026-10-12 22:29 UTC 整库约 1.03 GiB，其中报告关系约 1.0 GiB，占 96%。另外还有 Supabase 管理的系统、认证、Storage、Cron 等对象，本轮不删除这些平台对象。

| 表 | 保存的数据 | 本轮目标 |
| --- | --- | --- |
| `report_snapshot` | 完整已发布报告、输入指纹、发布时间、前序报告指针 | 最近 3 天，加当前 latest 与其直接回滚祖先；其他过期报告删除 |
| `article_candidate` | 候选文章、来源、处理/质量状态、最近发现时间 | 普通 30 天，拒绝候选 7 天；未结束刷新关联数据受保护 |
| `refresh_run` | 刷新来源、状态、耗时、指标、错误、发布报告指针 | 已结束记录 30 天，失败 90 天；仍被来源/报告/候选引用的记录保留 |
| `source_state` | 来源启用状态、采集节奏、失败状态、增量游标 | 保留当前来源状态 |
| `runtime_state` | latest 指针及最近成功/失败状态 | 保留单例 |
| `refresh_lease` | 当前租约、owner、fencing token | 保留单例；清理拒绝与活跃刷新并行 |

报告正文原本已有 compact/gzip 和内容 hash 去重。主要问题是快照持续累计、已部署清理任务反复超时；读取窗口不等于数据保留期限。

## 新版独立 PostgreSQL

以下按业务分组列出持久化表。没有明确 TTL 的业务记录不会因本轮减量被直接删除。

| 分组 | 表名 | 用途和保留策略 |
| --- | --- | --- |
| 来源、文章、采集运行 | `sources`, `fetch_runs`, `articles`, `article_revisions`, `article_discoveries` | 来源与游标、采集执行、当前正文/HTML/raw/media、正文修订和多来源发现；保留阅读、重新评估与去重所需内容 |
| 采集中间状态 | `collection_intakes`, `collection_batches`, `collection_items`, `collection_flow_control` | 可恢复采集输入、分批候选、详情重试和流控；候选完成后立即移除重复正文，完整 intake 结束 1 小时后删除批次/条目；待处理和重试尾项保留 |
| 受控试运行 | `dailynews_trials`, `dailynews_trial_sources`, `dailynews_trial_articles`, `dailynews_trial_reports` | 试运行范围、文章成员、验收证据；不清理，不自动扩大调度白名单 |
| 翻译与编辑 | `translations`, `translation_attempts`, `analyses`, `editorial_overrides`, `editorial_decisions`, `fact_editorial_state` | 翻译、模型/规则判断、人工改判和编辑历史；无通用 TTL |
| 发布、搜索、派生状态 | `publications`, `selected_ledger`, `selected_state`, `pool_search`, `grouping_overrides`, `regroup_pending`, `editorial_batch_state`, `fact_feature_cache` | 公开投影、增量同步、检索和分组；搜索复制最多 12k 正文字符并建索引，缓存按业务更新/过期；本轮保持 |
| 事件和事实 | `stories`, `story_aliases`, `story_links`, `story_digests`, `facts`, `fact_articles`, `story_signals`, `story_heat_hourly`, `hot_rankings` | 事件关系、摘要、事实证据、热度时序；`hot_rankings` 已有 30 天清理，其余无通用 TTL |
| 报告、向量、分组 | `reports`, `report_revisions`, `topics`, `embeddings`, `grouping_decisions`, `quote_translations` | 新版聚合报告及修订、主题、向量、分组理由和引用翻译；不是旧 Supabase `report_snapshot`，本轮不删除人工/业务历史 |
| 付费请求 | `receipts`, `receipt_attempts`, `budgets`, `service_prices` | 上游响应、请求摘要、请求 ID、每次 token/费用、预算与价格快照；大响应无损 gzip，保留恢复/复用与费用证据；默认关闭压缩写入，读取器升级完成后启用 |
| 管理、反馈、审计 | `audit_log`, `admin_users`, `admin_sessions`, `feedback`, `feedback_bans`, `ingest_events`, `settings` | 审计前后值、管理员登录、反馈、导入事件、设置；本轮不变 |
| 运行与文件 | `job_runs`, `stored_files` | 运行历史正常 30 天、失败 90 天；文件元数据按 `expires_at` 删除，并清理对应磁盘文件 |
| 通知 | `notify_targets`, `deliveries`, `delivery_leases` | 通知目标、发送回执及租约；到期租约删除，其他业务记录保持 |
| Monitor | `monitor_posts`, `monitor_events`, `monitor_event_posts`, `monitor_state` | 社交贴文、原始上下文、识别结果、事件证据、增量状态；无通用 TTL |
| 模型榜单 | `lb_models`, `lb_aliases`, `lb_snapshots`, `lb_scores`, `lb_runs`, `lb_rankings`, `fx_rates`, `lb_prices` | 模型与别名、上游快照、成绩、排名计算、汇率/价格；无通用 TTL |
| 评测与人审 | `selectbench_runs`, `selectbench_results`, `review_batches`, `review_tasks`, `review_revisions`, `review_calibration_candidates`, `review_calibration_state`, `review_calibration_members`, `review_calibration_actions` | 评测结果、人审原始快照/答案、校准候选与规则证据；本轮不变 |
| 持久化队列 | `pgboss.job` 及其 `job_common` 分区、queue/schedule 等管理表 | 任务 payload/output、状态、重试与计划；本轮成功任务 1 天，failed/cancelled 7 天，每小时最多删 5,000 条；pending/retry/active 保留恢复能力 |
| schema 版本 | 迁移框架版本记录、pg-boss 版本记录 | 已应用 schema 版本；不是内容历史，保持 |

## 数据库以外

| 位置 | 保存的数据 | 策略 |
| --- | --- | --- |
| `config.dataDir/uploads`、`feedback-screenshots` 及 `stored_files.key` 对应文件 | 上传附件、反馈截图 | 按文件 `expires_at` 清理 |
| `imgcache`、`ogcache` | 代理图片、分享图等可重建缓存 | 30 天 |
| 本地 `backups`、配置的 S3 兼容 bucket | 数据库 dump、单独打包的附件 | 本地按 `KEEP_LOCAL`，远端依 bucket 生命周期；真实远端配置未核实 |
| 本次忽略目录和独立备份目录 | 清理前备份、隔离验证与恢复证据 | 不计入 Supabase 占用；不提交新闻正文或凭据；保留到恢复与交付验收完成 |

最大的可裁剪重复内容是完成后的 `collection_items.candidate/need`、终态队列 payload/output 和 `receipts.response`。正文修订、人工标注、付费回执元数据和现有公开内容各自承担业务功能，本轮没有把它们当作垃圾删除。
