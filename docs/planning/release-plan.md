# Supabase 实时更新发布计划

## 目标

在现有 Supabase 持久运行态上完成完整性优先重构，使后台每 5 分钟检查一批来源、30 分钟完成全轮，并在局部失败、冷启动和内容静默时继续返回真实 last-known-good。

## 发布前提

- 数据模型、RPC、RLS 与 pgTAP 通过 [database-design.md](database-design.md) 和 [test-plan.md](test-plan.md) 的上线门；
- `GET /api/news` 不抓取新闻源，`GET /api/cron` 与 `POST /api/refresh` 共用唯一刷新 orchestrator；
- 动态 enabled source 在持久 due-state 驱动下滚动 30 分钟全部尝试；partial/failed 来源优先重试但不能饿死正常来源；
- 旧 fallback 不改写 `reportId`、`generatedAt`、`lastSuccessAt`；
- 所有用户可见状态和错误为中文且不含 secret。

## 资源和配置

| 位置 | 变量/资源 | 规则 |
| --- | --- | --- |
| Supabase | production project | schema 只通过仓库 migration 变更 |
| Vercel server | `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | 仅 Production/Preview 中需要的 scope；不加 `VITE_` |
| Vercel server | `CRON_SECRET`, `DAILY_NEWS_REFRESH_TOKEN` | cron 与人工刷新分开，可独立轮换 |
| Supabase Vault | refresh URL 与 cron secret | 只保存值；migration 只引用约定 secret 名 |
| Supabase Cron | `*/5 * * * *` | 通过 `pg_net` GET 生产 `/api/cron` |

真实值不得写入文档、提交、命令输出或聊天。数据库 password/PAT 只用于 CLI 登录/迁移，不是应用 runtime 变量。

## 分阶段执行

### 0. 代码与确定性验收

1. 从 `origin/main` 创建隔离 `codex/news-pipeline-stability` worktree，不带入原工作区未提交改动；
2. 新增向后兼容 migration、pgTAP、NewsStore contract、完整性、调度、API、前端与 GitHub Actions；
3. 本地运行 unit、integration、build、database tests 和 diff-check；
4. 推送 draft PR，独立自审全部 diff，修复 P0–P2，等待 `app-tests` 与 `database-tests` 全绿；
5. 将 PR 标为 ready 后 squash merge 并删除远端分支。

### 1. Staging migration 与 shadow

1. `supabase link` 到独立 staging；
2. 先 `db push --dry-run`，确认无破坏性 SQL，再正式 push；
3. 从 `public/daily-news.json` bootstrap 一份保留原 `generatedAt` 的基准 snapshot；
4. 两个独立 Node 进程验证 A 写 B 读、候选幂等、租约 fencing、原子发布和回滚；
5. shadow 刷新写 staging，但公开站仍读原路径，直到上线门全部通过。

### 2. 生产 migration 与应用部署

1. 对 production 重复 migration dry-run/list 检查；
2. push migration 并 bootstrap 基准 snapshot；
3. 在 Vercel 配置 server-only 环境变量；
4. 先部署“Supabase 优先读、bundled 降级”，但暂不启用 cron；
5. smoke `/api/news`、`/api/health`、未授权 cron/refresh 和冷实例读取。

### 3. 手动刷新与调度接管

1. 使用受保护 endpoint 手动运行至少两轮，确认来源组发生轮转，第二份报告输入包含两轮候选；
2. 查询 durable run/source/latest，确认无双 latest、无旧时间重盖、无敏感错误；
3. 将生产 URL 与 `CRON_SECRET` 写入 Supabase Vault；
4. 启用 5 分钟 Supabase Cron，观察至少六个真实时间槽和一次重复/并发调用；每个时槽同时核对 pg_net HTTP 与 durable refresh run，不能只看 Cron 入队成功；
5. 确认已打开网页在新报告发布后 60 秒内自动收敛。

### 4. 24 小时 burn-in

保持 bundled fallback 和上一快照可回滚。每个 5 分钟自然槽记录 Cron、pg_net、durable run、snapshot/runtime 原子链接、source state、公开 report ID、完整性指标和分轴状态。通过标准：动态 enabled 来源滚动 30 分钟全部尝试、`unmappedCandidateCount=0`、24 小时 latest recall=100%、无 selection-caused failed run、无双发布/secret 泄漏。

### 5. 7 天生产 soak

按 [test-plan.md](test-plan.md) 统计调度成功率、报告年龄 P95、API P95、来源 cadence、source-to-site 延迟和内容质量。全部达标后才宣布“实时更新功能最终验收完成”。

## 回滚

触发条件包括：migration/RPC 错误、latest 指针异常、连续两个周期无成功、报告质量明显坍缩、API 错误率或延迟超标、凭据疑似泄漏。

1. 先禁用 Supabase Cron，停止新写入；
2. 若数据库和旧快照健康，调用受保护 rollback RPC 原子切回上一成功 report；
3. 若 Supabase 读取不可靠，部署回 bundled-first 读取；保留 stale/degraded 提示，不能伪装 fresh；
4. 轮换任何疑似泄漏的 Supabase/Vercel/Vault secret；
5. 用前向 migration 修复 schema，不在生产直接删除数据或执行未审查 down migration；
6. 恢复前重跑上线门，并从手动两轮刷新重新开始观察。

## 发布验收记录

每次发布至少记录：commit/deployment、migration version、bootstrap report ID、两轮手动 run ID、cron 首次成功时间、冷实例可见耗时、回滚演练结果、24 小时与 7 天指标。记录只保存标识和聚合指标，不保存 secret 或外部完整响应。

本次生产执行与未关闭的门禁证据见 [production-acceptance-2026-07-13.md](production-acceptance-2026-07-13.md)。前八次 24 小时窗口分别因调度、来源 cadence、读恢复、容量、deployment 连续性或 P95 硬门失败/被取代。第九次窗口只保存了前 30/96 个严格槽的完整 Cron、pg_net、durable 与 runtime 证据；其余 66 个槽没有在 pg_net 的 6 小时 TTL 内落盘，不能判定通过。`2026-07-18` 第一版直连排序修复仍在同日/无日期 HTML 与逆序 feed 上触发 stale 硬失败。第二版用有界文章 metadata 探测、feed 补日期后重排、全局 HTTP 闸门和严格 deadline 语义修复，已通过 unit 145/145、integration 64/64、build 1711 modules、真实两来源与 11 来源只读 canary，并发布为 production deployment `dpl_2rrwW4zspHmJCk77T1kBcwzAP8Cy`。用户授权生产只读查询后，09:45 自然槽完成四层与公开内容门闭环，但 10:00 首个严格槽中 Anthropic 连续第二槽 `planned→skipped`，健康来源真实尝试间隔达到 108.104 分钟，第十次窗口按 cadence 硬门判失败。针对 HTML anchor 日期遗漏、陈旧候选过晚过滤和 self-link 重复抓取的最小修复通过 unit 146/146、integration 64/64、build 1711 modules、diff-check 与精确 11-source 不写库 canary，并作为唯一 production deployment `dpl_BPP9QWt15YZ5ERshpUu3Zh44S1zd` 发布。10:30 自然槽四层闭环，2/2 来源 attempted、0 skipped/missing，Anthropic state 正确推进；第十一次窗口从 `2026-07-18T10:30:23.044Z` 起算，严格槽从 10:45 开始。只有完整 24 小时通过后才能进入 7 天 soak。

## 待确认

- Supabase production project 的区域、长期配额和维护责任；
- 独立 staging project 是否作为后续 migration 的强制前置；本次生产远端 pgTAP 与空库兼容运行时已通过，但没有长期 staging 环境；
- 7 天观察异常由谁接收通知；
- 生产 source-to-site 抽样由人工还是脚本保存。
