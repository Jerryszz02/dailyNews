# Supabase 实时更新发布计划

## 目标

把 Daily News 从 bundled JSON + 单进程内存刷新迁移到 Supabase 持久运行态，使公开网站能由后台每 15 分钟检查多个来源，并在跨 Vercel 实例、失败和冷启动情况下继续返回真实 last-known-good。

## 发布前提

- 数据模型、RPC、RLS 与 pgTAP 通过 [database-design.md](database-design.md) 和 [test-plan.md](test-plan.md) 的上线门；
- `GET /api/news` 不抓取新闻源，`GET /api/cron` 与 `POST /api/refresh` 共用唯一刷新 orchestrator；
- 正常健康状态下，49 个 enabled source 在持久 due-state 驱动下滚动 90 分钟全覆盖；circuit-open 来源按独立半开恢复标准验收；
- 旧 fallback 不改写 `reportId`、`generatedAt`、`lastSuccessAt`；
- 所有用户可见状态和错误为中文且不含 secret。

## 资源和配置

| 位置 | 变量/资源 | 规则 |
| --- | --- | --- |
| Supabase | production project | schema 只通过仓库 migration 变更 |
| Vercel server | `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | 仅 Production/Preview 中需要的 scope；不加 `VITE_` |
| Vercel server | `CRON_SECRET`, `DAILY_NEWS_REFRESH_TOKEN` | cron 与人工刷新分开，可独立轮换 |
| Supabase Vault | refresh URL 与 cron secret | 只保存值；migration 只引用约定 secret 名 |
| Supabase Cron | `*/15 * * * *` | 通过 `pg_net` GET 生产 `/api/cron` |

真实值不得写入文档、提交、命令输出或聊天。数据库 password/PAT 只用于 CLI 登录/迁移，不是应用 runtime 变量。

## 分阶段执行

### 0. 代码与确定性验收

1. 固定 Supabase CLI 和 `@supabase/supabase-js` 版本；
2. 新增 migration、pgTAP、NewsStore contract、freshness、调度轮转、API 和前端测试；
3. 运行 `npm test`、integration、Supabase database tests 和 `npm run build`；
4. 保存测试数量、耗时和失败语义证据。

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
4. 启用 15 分钟 Supabase Cron，观察至少两个真实时间槽和一次重复/并发调用；每个时槽同时核对 pg_net HTTP 与 durable refresh run，不能只看 Cron 入队成功；
5. 确认已打开网页在新报告发布后 60 秒内自动收敛。

### 4. 24 小时 burn-in

保持 bundled fallback 和上一快照可回滚。每个周期记录 run、已选来源、发现/采用数量、report ID、年龄和错误码。通过标准：最大成功间隔不超过 30 分钟、49 源轮转达标、无双发布/候选丢失/secret 泄漏。

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

本次生产执行与未关闭的门禁证据见 [production-acceptance-2026-07-13.md](production-acceptance-2026-07-13.md)。发布门已通过，但前四次 24 小时 burn-in 分别因调度丢槽/耗时、4 毫秒到期边界、deadline cadence 缺口与 `PGRST303` 读请求未恢复而失败。第五次窗口中识别出 10-source 上限无法同时容纳正常 cohort 与半开恢复；默认提升到 11 后，真实 11/11 canary 在 27.854 秒内通过，49/49 来源 rolling 覆盖且 backlog=0。第五次窗口被容量修复部署取代，第六次窗口又被相同 `main@1da2f89` 的新 production deployment 切换打断；固定 `dpl_GFixDDM6FS1MHrohLLjce72p8X3w` 的第七次窗口随后因第 5 个大于 30 秒的轮次使完整 P95 不可恢复而失败。采集预算降至 12 秒的修复部署并通过真实四层 canary 后，才能从新基线启动第八次 24 小时窗口；逐槽硬门通过后才能进入 7 天 soak。

## 待确认

- Supabase production project 的区域、长期配额和维护责任；
- 独立 staging project 是否作为后续 migration 的强制前置；本次生产远端 pgTAP 与空库兼容运行时已通过，但没有长期 staging 环境；
- 7 天观察异常由谁接收通知；
- 生产 source-to-site 抽样由人工还是脚本保存。
