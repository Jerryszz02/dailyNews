# Supabase 生产验收记录（2026-07-13）

## 当前结论

状态：**前八次 24 小时 burn-in 均未通过或被后续部署取代；第九次窗口只保存了前 30/96 个严格槽的完整 pg_net 证据，剩余 66 个槽在 6 小时 TTL 过期前没有落盘，因此不能判定通过。`2026-07-18` 公开门又确认报告停止推进并触发真实内容新鲜度硬失败；已定位直连 HTML 候选在截断前未按时间排序，最小修复已通过本地与真实来源验证，等待单次生产部署后重新建立第十次窗口**。

Supabase 持久化、两次生产迁移、Vercel 读取、受保护刷新和 15 分钟 Supabase Cron 已部署。当前 production deployment `dpl_DFgdwpoPUfPe8UGnJVGLexDGhRKY` 来自 `main@094fb36`，包含 12 秒采集预算、并发 11、有界只读重试、deadline 来源公平、首页活动时间门、核心媒体共享配额、compact 网页响应与分层 Vercel 边缘缓存。前八次窗口依次暴露并修复调度丢槽、到期边界、deadline cadence、Supabase 瞬时读失败、半开容量和 P95 问题。第九次窗口前 30 个严格槽的调度与来源证据均通过，但后续 66 个理论槽没有在 pg_net 的 6 小时 TTL 内保存完整响应证据，不能用后来的 durable 或公开 API 状态倒推替代。`2026-07-18` 的公开检查进一步证明“Cron/lastSuccessAt 推进”不等于“新内容发布”：latest report 停在 04:15Z，实际候选与首页活动超过 120 分钟，`/api/health` 返回 503 stale。24 小时与随后 7 天 soak 完成前，仍不能把本记录解释为“实时更新最终验收完成”。

## 发布标识

| 项 | 值 |
| --- | --- |
| 当前生产 Git commit | `094fb36`（`Ensure every selected source starts`）；本机 `main` 与 `origin/main` 已 0/0 对齐，production deployment metadata 与该 commit 一致 |
| migration | `20260713090000_daily_news_store.sql`、`20260713101500_runtime_hardening.sql`；local/remote list 一致且无 pending dry-run |
| bootstrap report | `ec5f550b-69ee-4324-bac7-143ef5d2e86b`，保留原始 `dataAsOf=2026-07-09T15:39:06.365Z` |
| production deployment | 当前 `dpl_DFgdwpoPUfPe8UGnJVGLexDGhRKY`；READY production，正式 alias 已精确指向它；上一版本为 `dpl_4nAPHWn6LxkvfQ3Ksqn6PhFCZ3mR` |
| production alias | `https://daily-news-tau-taupe.vercel.app` |
| cron job | `jobid=2`，`daily-news-refresh`，`*/15 * * * *`，active；重装后首个时槽 `2026-07-13T10:45:00Z` 已闭环 |

本记录只保存公开 URL、标识符和聚合结果；不保存 Supabase、Vercel、Cron、刷新或翻译凭据。

## 确定性与数据库证据

| 检查 | 结果 |
| --- | --- |
| `npm test` | 通过：14 个文件、137 个测试 |
| `npm run test:integration` | 通过：7 个文件、64 个测试 |
| `npm run build` | 通过：TypeScript 与 Vite production build，1711 modules |
| `git diff --check` | 通过 |
| 远端 pgTAP | 通过：plan 72、passed 72、failed 0；事务回滚后生产状态不变 |
| clean migration 结构检查 | 两次空库兼容运行时重放通过：6 张 internal table、15 个 public RPC；旧无租约 source-sync RPC 已删除 |
| 事务 smoke | 通过：候选幂等、lease takeover/fencing、原子 latest、失败不覆盖、A→B→A 新快照、三次失败熔断、anon denied |
| 权限边界 | publishable key 访问 `net`、`vault`、`daily_news` 均为 `406/PGRST106`；未授权 Daily News RPC 为 `401/42501` |
| tracked/untracked secret scan | 业务源码与文档可疑文件数 0；测试目录唯一命中为固定假 token |

本机没有 Docker，因此官方 `supabase test db` 本地容器路径不可用；使用同一 migration/pgTAP 在远端 Supabase PostgreSQL 执行，并另用空库兼容运行时做结构与事务复核。该差异是验收证据的一部分，不记为测试通过的替代命令。

## 生产刷新证据

| 入口 | run ID | 状态 | 来源数 | 本轮发现 | 候选池 | report ID |
| --- | --- | --- | ---: | ---: | ---: | --- |
| 手动刷新 1 | `31cfa646-7ad2-4f07-8eaf-c4993ef705ea` | published | 10 | 40 | 40 | `1908b741-fe11-4618-940f-71354d9a0f1f` |
| 手动刷新 2 | `40a79e70-ae1c-40f9-b924-9e4f5408344a` | published | 10 | 10 | 50 | `19cb1611-d5f1-40d3-b00c-e83d34eb9ac1` |
| Cron 鉴权 smoke | `09a2cc39-0667-40ab-b189-0fbce2794c4f` | published | 10 | 10 | 60 | `abca4e46-8bb0-412e-9b2a-c846017df5f4` |
| 首个真实 Cron 时槽 | `5c51948e-a021-4913-b1ec-ca26d13d5aa9` | published | 10 | 13 | 73 | `f0d5d5cb-ccf5-4ee7-ba3c-5696a4b7729b` |
| 安全/内容修复后 Vault canary | `417aa198-3da8-4df5-b66f-0464b0c7a478` | published | 9 | 6 | 77 | `4a12196b-9cd1-4363-82f5-29503cd8aac6` |
| Cron 重装后时槽 1 | `2370f66d-1e1c-4e1f-a925-3cb12594fca0` | completed/unchanged | 0 | 0 | 77 | 不切换 latest |
| Cron 重装后时槽 2 | `b6e3c625-bcbb-4d43-8488-e2e57f981e22` | completed/unchanged | 0 | 0 | 76 | 不切换 latest |
| Cron 重装后时槽 3 | `33b8f580-2d33-4714-a670-0c62518636f6` | completed/unchanged | 0 | 0 | 76 | 不切换 latest |
| 11:30 有源 canary | `e61c96f9-f757-458c-ad9e-fbb6c044771b` | published | 10 | 31 | 78 | `e8f8a375-4e23-4a1e-b50a-183f5341b0e6` |

首次发布门阶段的 latest 为 `e8f8a375-4e23-4a1e-b50a-183f5341b0e6`，生成于 `2026-07-13T11:30:01.686Z`，最新内容活动时间为 `2026-07-13T10:00:00Z`。该轮从 `11:30:03.240Z` 到 `11:30:31.625Z`，总耗时 `28.385` 秒，通过 E5。此前 10:25 轮为 `31.342` 秒并暴露旧 25 秒采集预算过长；降到 22 秒后已由真实有源轮证明整轮低于 30 秒。10:45、11:00 与 11:15 UTC 三个无来源到期轮只推进真实检查时间，均保留 report ID/dataAsOf，证明不会用空轮洗新旧新闻。

来源状态在 `2026-07-13T11:32:40Z` 为：49 enabled、19 个在最近 90 分钟内已尝试、18 成功、0 熔断、129 条候选中 78 条在 72 小时窗口；30 个来源因启动期同批到期仍处于 backlog。11:45、12:00 及后续时槽必须证明该 backlog 按 `next_due_at` 公平消化并恢复 49 个健康来源的滚动 cadence。

## 首次 burn-in 失败与修复（2026-07-15）

首次窗口固定为 `2026-07-13T11:31:22Z` 至 `2026-07-14T11:31:22Z`。只读审计同时关联 `cron.job_run_details`、`net._http_response`、`daily_news.refresh_run`、snapshot/latest 与 source state；没有把 pg_cron 的入队成功当成端到端成功。

| 检查 | 首次窗口结果 | 判定 |
| --- | --- | --- |
| Cron | 96/96 `succeeded`，最大启动间隔约 15.003 分钟 | 仅证明 pg_net 入队 |
| durable run | 73 个：64 published、9 completed、0 failed；23 个 cron 槽没有 durable run | 不通过，端到端覆盖 76.0% |
| 最大成功间隔 | 75.028 分钟 | 不通过，硬门为不超过 30 分钟 |
| 单轮耗时 | P95 约 30.607 秒、最大 31.138 秒 | 不通过，硬门为 P95 不超过 30 秒 |
| 来源轮转 | 49 源最终均尝试过，但首次全覆盖耗时约 118.7 分钟；修复前当前健康源仅 39/48 在滚动 90 分钟内尝试，9 个健康源 due | 不通过 |
| 原子性/候选 | runtime singleton 1、latest target 1、orphan/broken link 0、候选必填字段丢失 0、同源 URL 重复 0 | 通过 |

审计时 pg_net 0.20.3 的 `pg_net.ttl` 为 6 小时；旧 24 小时窗口的 HTTP 响应已被清理。最近仍保留的 24 条响应中，20 个 HTTP 200、4 个 HTTP 500；其中 3 个只有通用 `Internal Server Error` 且没有 durable run，另 1 个是可审计并随后恢复的 `stale_candidate_pool`。对应 Vercel runtime 日志确认至少一个通用 500 发生在 lease 之前的 `SupabaseNewsStore.readState`，归一化错误为 `supabase_request_failed`。当前数据库角色没有修改 `pg_net.ttl` 的参数权限，Supabase 管理 CLI 也没有登录令牌，因此本轮未绕过权限改配置；hourly burn-in 必须逐次保存仍在 TTL 内的 HTTP 聚合证据。

`dpl_BRnag7KxJuPCrhpwXavJVj9wCDf1` 包含以下最小修复：

- Supabase 只读 RPC 单次 4 秒超时、250/750ms 退避、最多 3 次；只重试明确连接、资源、查询取消和 PostgREST 连接类错误；所有写 RPC 仍只调用一次；
- `readRecentCandidates` 的分页读取使用相同有界重试，失败页不会重复 append；
- 采集预算从 22 秒降为 16 秒，为持久读取、聚类和发布留出 30 秒门余量；
- `collection_deadline` 统一作为中性 skipped；未开始、deadline 中止或缺少 collector outcome 的来源不推进 `lastAttemptAt/nextDueAt/consecutiveFailures`，并在 run metrics 记录 planned/attempted/skipped/missing 聚合；
- collector 整体异常时不再把全部 planned 来源伪装成 attempted。

首轮修复后 `npm test` 129/129、integration 58/58、build 与 `git diff --check` 均通过。部署 alias 已切到新 deployment；完整/compact API、health、reload no-store 与非法 query 400 均通过。部署时公开报告为 212 个事件、25 个来源，核心 21 条全部 confirmed，候选/首页活动年龄约 10.7/47.8 分钟，最高核心媒体占比 0.143，标题/摘要/组合重复均为 0。

`2026-07-15T09:30Z` 首槽完成 cron→HTTP 200→durable completed/unchanged→runtime 闭环，耗时 3.530 秒，但因调度时间比下一批 `next_due_at` 早约 0.5 秒而没有到期来源，只能证明无源路径。受保护人工 canary 因本机临时文件没有 refresh token 返回 401，未创建 run、未改变生产；不拉取或输出凭据。

`2026-07-15T09:45Z` 的真实有源 cron canary 完成四层闭环：run `7d04bd1e-8f34-4bd6-81b8-0bc3b88b65d5`，pg_net HTTP 200/published，10 planned、10 attempted、0 skipped、0 missing，发现/采用 9 条，27.960 秒发布 report `2be5aea9-d07e-4ec4-8686-272771549331`。runtime singleton/latest target 均为 1；49/49 enabled 来源在滚动 90 分钟内已尝试、46 成功、due backlog 0，2 个 circuit-open 按半开规则继续观察。新报告 full/compact 同步为 207 个事件、25 个来源，核心 21 条全部 confirmed；候选/首页最新活动年龄约 1.5/68.6 分钟，标题/摘要/组合重复均为 0，`maxPrimaryPublisherShare=0.143`。

但首个严格窗口内 `10:00Z` 时槽在 `scheduledAt=10:00:01.514Z` 选源，最早持久 `nextDueAt=10:00:01.518Z`，仅早 4 毫秒；实际进入刷新时已是 `10:00:03.547Z`，旧逻辑仍用入口时间判定到期，因而完成 0-source unchanged。四层闭环本身为 Cron succeeded、HTTP 200、durable completed、runtime 更新，但随后 10 个来源立即 due，滚动 90 分钟覆盖从 49/49 降到 39/49，因此该窗口也判失败。

边界热修在状态读取完成后以 `max(scheduledAt, wall-clock now)` 判定 due/circuit，槽幂等、报告时间和持久 nextDue 仍使用 `scheduledAt`；无需数据库 migration。精确 4 毫秒回归测试修复前得到 0 源、修复后正确尝试来源；`npm test` 130/130、integration 59/59、build 和 `git diff --check` 通过，部署 `dpl_Fv6Dgr9TEU6ZvEnkQBBrV1CYBefp` 已接管 alias。

`10:15Z` 热修有源 canary 完成 Cron→HTTP 200→durable published→runtime latest 四层闭环：run `a8707188-baad-409b-b1a2-aff9d83cae84` 在 27.886 秒内发布 report `69267d3d-5bc2-42b9-b068-afaaa2246b2b`，10 planned、7 attempted、3 deadline skipped、0 missing，发现/采用 14 条；runtime singleton/latest target 均为 1，新报告 208 个事件、核心 21 条，`maxPrimaryPublisherShare=0.143`。三个 skipped 来源均未推进 `last_run_id/lastAttemptAt`，仍留在 due 队列。`10:17Z` 可执行 backlog 为 12，其中 3 个来自 `10:00`、9 个在 `10:15` 到期；滚动 90 分钟覆盖尚未恢复，因此尚未重新起算 24 小时 burn-in。

`10:30Z` 下一轮 run `ebf85586-af94-4416-8138-cab9545dce38` 同样完成四层闭环，在 27.147 秒内发布 report `42a330bd-8067-495b-bcc7-b68911b67467`；10 planned、8 attempted、2 skipped、0 missing，发现/采用 13 条。上一轮 3 个最老 skipped 本轮全部真正 attempted、重复 skipped 0，证明持久 due 优先级可以公平重试；但可执行 backlog 从 12 增为 14，滚动 90 分钟覆盖仍只有 34/49，两轮平均 attempted 7.5，低于全 49 源所需的每槽 8.17，因此容量门继续观察且 burn-in 起点仍为空。

`10:45Z` 第三轮 run `b05f2cd1-1fd2-4c38-8b48-47f1322d289d` 在 29.019 秒内发布 report `9b173e89-6c7c-4467-8683-e0204f877c8f`；10 planned、10 attempted、0 skipped、0 missing，发现/采用 14 条。上一轮 2 个 skipped 本轮也全部真正 attempted；三槽平均 attempted 为 8.33，高于 49 源理论所需的 8.17，eligible backlog 从 14 降到 13，暂不把默认直连并发从 6 提高到 8，避免无证据增加 33% 峰值。滚动 90 分钟覆盖仍只有 35/49、2 个 circuit-open，容量恢复方向成立但尚未达到重新起算门槛；继续观察完整六槽，直到全部健康源覆盖且 eligible healthy due 清零。

`11:00Z` 第四轮 run `6cd252f6-1825-4d2c-8fc0-38c0dc84d0bb` 在 28.983 秒内发布 report `b46401b6-8bb7-4ddc-bb08-00d9c2ca6a90`；10 planned、10 attempted、0 skipped、0 missing，发现/采用 8 条。严格窗口 distinct 健康来源覆盖升至 35/47，eligible healthy due 降到 3。

`11:15Z` 第五轮 run `9850b0b4-a2e0-406f-b1b2-7062822ab182` 在 27.598 秒内发布 report `c5b0dd88-e0dd-4c15-9c1b-ef5505a64dea`；10 planned、8 attempted、2 skipped、0 missing，发现/采用 10 条。8 个 attempted 仍全部是窗口新来源，覆盖升至 43/47；2 个 skipped 保留 due 状态等待下一槽。

`11:30Z` 第六轮 run `de7be4fb-250d-4559-8a3f-1e34c236c7fb` 在 14.871 秒内 completed/unchanged；4 planned、4 attempted、0 skipped、0 missing，发现/采用 0 条。11:15 的 2 个 skipped 与另外 2 个 due 来源本轮全部真正 attempted；内容哈希未变化，因此没有创建无意义 snapshot，也没有改写 report ID、generatedAt 或 dataAsOf，只推进 runtime 的真实 `lastAttemptAt/lastSuccessAt`。

完整恢复窗口 `2026-07-15T10:15:00Z` 至 `11:30:18.775Z` 理论/实际均为 6 槽：Cron 6/6 succeeded，pg_net 6/6 HTTP 200（5 published、1 unchanged），durable 为 5 published、1 completed，失败、缺槽、重复、running 和 missing 均为 0；总计 54 planned、47 attempted、7 skipped，47 个 attempted 全部 distinct，六槽内 7/7 skipped 均在紧邻下一槽补跑。P95/max 为 29.019 秒，最大成功完成间隔 15.051 分钟；47/47 非熔断健康来源在严格 90 分钟窗口内全部覆盖，eligible healthy backlog=0。其余 2 个 enabled 来源处于 circuit-open，按既定半开规则继续观察。恢复门因此通过，默认直连并发保持 6，不做无证据扩容；第三次 24 小时 burn-in 从第六轮真实 `finished_at=2026-07-15T11:30:18.775Z` 起算。

## 第三次 24 小时 burn-in（未通过）

窗口原定为 `2026-07-15T11:30:18.775Z` 至 `2026-07-16T11:30:18.775Z`；11:30 run 正好在起点完成，是基线而不是窗口内缺槽。该窗口在第二个定时槽 `12:00Z` 已违反来源轮转硬门，因此终点作废：

| 时槽 | Cron / pg_net | Durable | 来源 planned/attempted/skipped/missing | 耗时 | 结果 |
| --- | --- | --- | --- | ---: | --- |
| 11:45 | succeeded / HTTP 200 published | `a1c14931-52ee-4891-a3b1-8dd13142b61b` published | 8/8/0/0 | 26.600s | report `969986ae-67cb-4aa1-8f03-6cfc980f0ce3` |
| 12:00 | succeeded / HTTP 200 published | `0170e0fd-1c16-46f5-b78c-a2c5efd90b70` published | 8/6/2/0 | 27.675s | report `bfbd38b9-9ba0-4bc6-8f50-fe9ad3ab4231` |

两个时槽的 Cron、pg_net body、durable run、snapshot 与 runtime latest 的 run/report ID 均一致；失败、缺槽、重复、running、orphan、链接错配和 supersedes 顺序异常均为 0，P95/max 27.675 秒，最大成功完成间隔 15.184 分钟。11:45 的一个原 open circuit 已完成半开尝试并恢复健康；但 12:00 的 `openai` 与 `x-sam-altman` 因 collection deadline 明确 skipped，健康来源 rolling 90 分钟覆盖降为 46/48、eligible backlog=2。C4 要求正常健康状态下滚动 90 分钟全部覆盖；即使下一槽补跑，两个来源的相邻尝试间隔也已约 105 分钟，因此不能把 12:00 发布成功解释为来源门通过，第三次窗口在此失败。

`11:37:30Z` 曾有一次公开 `/api/health` 返回 503、`storage=bundled`、`lastError=storage_unavailable`；约 18 秒后恢复 200/Supabase 且仍指向当时 durable latest，随后 15/15 连续 health 采样均为 200，full/compact/reload 也同步。数据库侧 runtime、latest、recent refresh、Cron、pg_net 与候选读取在对应时段均正常，因此证据只支持一次请求级瞬时 fallback，不能进一步断言具体网络或冷启动成因。18 秒低于生产 60 秒收敛门，且 fallback 没有粘滞、没有旧 latest 或内部错误泄漏，所以该事件本身不构成窗口失败。`scripts/newsApi.test.ts` 已新增“首次 durable read 失败→health 503/news 200 degraded→下一请求恢复当前 Supabase latest”的回归。

## 并发 8 修复与 cadence 恢复（已通过）

默认 `DAILY_NEWS_SOURCE_CONCURRENCY` 从 6 提升到 8，保持 `maxSources=10`、16 秒采集预算和单请求 8 秒上限不变；生产没有显式同名环境变量覆盖。10 任务 barrier 测试证明释放前精确启动 8 个 worker、完成 0 个，释放后全部完成；完整 unit 132/132、integration 60/60、build 1711 modules 与 `git diff --check` 均通过。新 deployment `dpl_42GxM5xXz99nCsV4DaZvRiHVJeMy` 于 `12:09:10.829Z` Ready 并接管正式 alias，冷实例直接读取同一 Supabase latest。

`12:15Z` 新 deployment 首槽 run `212abce5-2973-4026-9cd1-3bd68dc968c0` 在 27.121 秒内发布 report `50c0b21f-6c69-42d7-b331-7692530db313`；Cron、pg_net、durable、snapshot/runtime 四层闭环，10 planned、10 attempted、0 skipped、0 missing，发现/采用 14/14。最老 `openai` 与 `x-sam-altman` 均真正 attempted、推进 next due 至 13:45，并把连续失败计数归零，证明并发 8 与 oldest-due 补跑 canary 有效。

由于 12:15 前共有 12 个 selectable due 而单槽上限仍为 10，本槽后仍有 `china-daily`、`mtime` 两个新 cohort backlog，rolling coverage 为 46/48。随后三个槽均完成四层闭环且无 skipped/missing：

| 时槽 | Durable run | planned/attempted/skipped/missing | 耗时 | 关键恢复结果 |
| --- | --- | --- | ---: | --- |
| 12:30 | `419b53d5-a7cd-48e4-ac54-ee0ca058ddb4` | 10/10/0/0 | 27.252s | `china-daily`、`mtime` 优先补跑，遗留新 cohort 2 个 |
| 12:45 | `eac473a0-bc88-49c6-a9fb-dc57cb3d2179` | 10/10/0/0 | 27.150s | `hugging-face`、`x-greg-brockman` 补跑；`npr` 半开真实尝试后因 timeout 重新 open，遗留 `x-karpathy` 1 个 |
| 13:00 | `8c3c9db4-9484-4e48-8e68-77ce3b1fe50f` | 5/5/0/0 | 15.201s | `x-karpathy` 优先补跑，eligible backlog 清零 |

`12:15Z` 至 `13:00Z` 新 deployment 四槽理论/实际 4/4，Cron 与 pg_net 均 4/4 succeeded/HTTP 200 published，durable 4/4 published，失败、重复、running、orphan 和链接错配均为 0；P95/max 27.252 秒，最大成功完成间隔 14.999 分钟。正确完整六槽 `11:45Z` 至 `13:00Z` 为 6/6 成功、49 次 attempted 全部 distinct、skipped 2、missing 0；所有已有下一槽的 skipped 累计 9/9 紧邻补跑。13:00 后 enabled 49、healthy 48、circuit-open 1（`npr`），健康来源 rolling attempted/succeeded=48/48，实际缺失 ID 为空，eligible healthy backlog=0。`npr` 在 12:45 半开被真实尝试但因 `source_timeout` 重新 open 至 15:45，符合 C5，当前不计入健康分母。

来源恢复门因此重新通过。第四次 24 小时 burn-in 以 13:00 run 的真实 `finished_at=2026-07-15T13:00:18.723Z` 起算，观察终点为 `2026-07-16T13:00:18.723Z`，首个纳入定时槽为 13:15Z；此前 11:30 起点保持作废。这只表示重新计时，不表示 24 小时已通过。

## 第四次 24 小时 burn-in（未通过）

窗口固定为 `2026-07-15T13:00:18.723Z` 至 `2026-07-16T13:00:18.723Z`。首个纳入时槽 13:15Z 已完成，起点保持不变：

| 时槽 | Cron / pg_net | Durable | 来源 planned/attempted/skipped/missing | 耗时 | 结果 |
| --- | --- | --- | --- | ---: | --- |
| 13:15 | succeeded / HTTP 200 published | `ca38f7fa-f83c-4686-95c2-9bced23e904f` published | 8/8/0/0 | 28.583s | report `6debb859-d8f3-4a7d-8f12-40f547015455` |
| 13:30 | succeeded / HTTP 500 generic | 未创建 | — | — | `readState` 在 lease 前失败，runtime 保留 13:15 latest |

首槽理论/实际为 1/1，Cron、pg_net 白名单响应字段、durable run、13:15 分钟唯一 snapshot 与 runtime latest 的 run/report ID 全部一致；失败、缺槽、重复、running、orphan、链接错配和 supersedes 顺序异常均为 0，最大成功完成间隔 15.237 分钟。该轮发现/采用 12/12，runtime singleton/latest target 均为 1，last error 为空。当前 6 小时 `pg_net.ttl` 窗口保留 24 条响应，其中 22 条 HTTP 200、2 条是本窗口开始前的历史 HTTP 500；本窗口 HTTP 500 为 0，22/22 个携带 run ID 的响应均匹配 durable run。

来源层在首槽后为 enabled 49、healthy 48、circuit-open 1、half-open 0；健康来源 rolling 90 分钟 attempted 48/48、succeeded 47/48，实际未尝试的健康来源 ID 为空，eligible healthy due backlog/cohort 均为空。首槽 8 个最早 due 来源的 planned/attempted 集合完全一致，状态均推进到 14:45；历史 skipped 的下一槽补跑保持 9/9，当前没有 pending fairness debt。`npr` 仍因 12:45 的 `source_timeout` 熔断至 `2026-07-15T15:45:01.790Z`，没有被伪装进健康分母，届时必须核对真实半开尝试。

13:30 时槽的 `cron.job_run_details` 为 succeeded，但 pg_net response `id=207` 为 HTTP 500、21 字节通用 `Internal Server Error`，没有 JSON run ID、没有 durable run，runtime 的 `lastAttemptAt` 与 latest 均停在 13:15；6 个健康来源随即 due，rolling attempted 降到 43/49。Vercel 同 deployment 日志把该 serverless `/api/cron` 失败定位为 `readState` 的 `supabase_request_failed`，source code `PGRST303`；函数超时、连接错误、未捕获异常和 refresh lease 信号均未命中。PostgREST 14 将 `PGRST303` 定义为 JWT claims 校验或解析失败；生产使用的是固定后端 opaque secret，前后请求使用同一配置均成功，因此证据支持一次请求级平台 key/claim 处理异常，而不是 secret 长期失效。第四次窗口据此在第二槽失败，13:00 起点作废。

## `PGRST303` 补强与 cadence 恢复（已通过）

最小修复只把 `PGRST303` 加入 `SupabaseNewsStore` 的读 RPC 有界重试：单次仍为 4 秒，250/750ms 退避，最多 3 次；写 RPC 仍严格只调用一次，权限、冲突和其他确定性数据库错误仍不重试。精确回归在修复前证明首次 `PGRST303` 立即失败且只调用 1 次，修复后第二次读取成功；完整 unit 133/133、integration 61/61、build 1711 modules 与 tracked/untracked diff check 均通过。新 deployment `dpl_FhVWbvoHb8M85jWFFXS7DNLLKEB5` 已 Ready 并接管正式 alias。

13:45 新 deployment 首个真实 canary 完成四层闭环：run `5e025de5-444e-46ad-b7c5-f5edca1653ee` 在 27.919 秒内发布 report `45655ad0-f163-4f18-a3c1-c17699773474`，10 planned、10 attempted、0 skipped、0 missing，发现/采用 16/16；runtime singleton/latest target 均为 1。10 个最老 due 来源全部推进到 15:15，证明 13:30 缺槽 backlog 被 oldest-due 优先消费；随后 6 个在 `13:45:01.522Z` 才到期的新 cohort 仍为 eligible due。

14:00 恢复槽继续完成 Cron→pg_net HTTP 200→durable→snapshot/runtime latest 四层闭环：run `db31acde-a7ac-43f9-95c6-8b6aa638fc78` 在 27.527 秒内发布 report `72de6550-d942-43c5-852f-1850abdd7756`，10 planned、10 attempted、0 skipped、0 missing，发现/采用 7/7。13:45 后遗留的 `36kr`、`google-ai`、`mit-tech-review`、`nba`、`openai`、`x-sam-altman` 均已真实 attempted 并推进 next due；13:45 与 14:00 两槽 Cron、pg_net、durable 均为 2/2 成功，失败、重复、running 与 ID 错配均为 0，最大成功间隔约 15.004 分钟，P95/max 27.919 秒。14:03 的完整 `pg_net.ttl=6 hours` 保留窗口共有 24 条响应：HTTP 200 为 22 条、HTTP 500 为 2 条、`error_msg` 非空为 0；两条 500 均早于本恢复窗口。随后 6 个在 `14:00:01.976Z` 到期的新 cohort 成为 backlog：`jiemian`、`jiqizhixin`、`meta-ai`、`microsoft-ai`、`nvidia-ai`、`yahoo-sports-nba`。14:03 时 enabled 49、healthy 48、circuit-open 1，健康 rolling attempted/succeeded 为 42/48 与 40/48，eligible healthy backlog=6；`npr` 仍 open 至 15:45。第五次 burn-in 起点继续为空，至少要等健康 rolling attempted 恢复 48/48 且 eligible backlog 清零。

14:15 run `009e11b9-b219-46df-af6b-744142203d7e` 在 28.121 秒内发布 report `d8c1b971-7a91-477b-ace6-0ca31dbef0ec`，10 planned、10 attempted、0 skipped、0 missing，发现/采用 5/5。14:00 的 6 个最老 backlog 全部补跑，同时消费 14:15 新 cohort 的 4 个来源；余下 5 个健康来源保持 due，等待下一槽。

14:30 run `87d4c964-74c5-4106-bcf1-1d3e9600c0f4` 在 28.472 秒内发布 report `7a7ab8c2-1831-4668-a481-81c886da882c`，10 planned、10 attempted、0 skipped、0 missing，发现/采用 5/5。上一槽余下 5 个 backlog 与本槽新到期的 5 个来源全部真实 attempted；选中状态均推进、selected last-run mismatch 为 0。13:45 至 14:30 四槽理论/实际 4/4，Cron 4/4 succeeded、pg_net 4/4 HTTP 200/published、durable 4/4 published；失败、缺槽、重复、running、非 JSON body、网络错误与 run/report 错配均为 0，最大成功间隔 15.019 分钟，run P95/max 28.472 秒。14:31 时 enabled 49、healthy 48、circuit-open 1，健康 rolling attempted/succeeded=48/48 与 46/48，缺失 ID 为空，eligible healthy backlog=0。完整 `pg_net.ttl=6 hours` 保留 24 条响应：HTTP 200 为 23 条、历史 HTTP 500 为 1 条、`error_msg` 非空为 0。来源 cadence 恢复门据此通过；`npr` 仍 open 至 15:45，届时必须验证真实半开。

## 第五次 24 小时 burn-in（未失败，但被最终版本窗口取代）

窗口固定为 `2026-07-15T14:30:33.535Z` 至 `2026-07-16T14:30:33.535Z`。14:30 run 的真实完成时间为起点基线，不算窗口内理论缺槽；首个严格槽为 14:45Z。起算时四层原子性、健康来源 rolling 48/48、eligible backlog=0、公开内容/API 门均通过。这只表示重新计时，不表示 24 小时已通过。

| 时槽 | Cron / pg_net | Durable | 来源 planned/attempted/skipped/missing | 耗时 | 结果 |
| --- | --- | --- | --- | ---: | --- |
| 14:45 | succeeded / HTTP 200 published | `222cc2a7-39ea-4ddd-b8dc-eb2455240c36` published | 8/8/0/0 | 28.132s | report `13959bd0-c1df-4810-8b16-e8fc49c541d5` |
| 15:00 | succeeded / HTTP 200 unchanged | `2c890187-841b-43c1-9e46-0978a6ecb126` completed | 0/0/0/0 | 2.755s | 无来源到期；保留 14:45 report |
| 15:15 | succeeded / HTTP 200 published | `99b72df4-5d47-4a7b-b47d-ed39877caa88` published | 10/10/0/0 | 28.695s | report `84aa5080-bf1b-4683-a72f-5862030833c2` |
| 15:30 | succeeded / HTTP 200 published | `17696325-e283-4b74-98eb-74633cb18ed9` published | 10/10/0/0 | 28.069s | 新 deployment 常规 cohort canary |
| 15:45 | succeeded / HTTP 200 published | `2a5aa58f-0319-4023-bbda-c230f0825e1d` published | 11/11/0/0 | 27.854s | `npr` 半开成功，report `8c41bb42-1b78-4187-aba8-f882e849ef0c` |

首槽 Cron、pg_net body、durable run、snapshot 与 runtime latest 的 run/report ID 全部一致；失败、缺槽、重复、running、非 JSON body、网络错误、orphan 和链接错配均为 0。8 个最早 due 来源全部真实 attempted 并推进 next due，selected last-run mismatch 为 0；enabled 49、healthy 48、circuit-open 1，健康 rolling attempted/succeeded=48/48 与 46/48，eligible healthy backlog=0。完整 `pg_net.ttl=6 hours` 保留 24 条响应，其中 HTTP 200 为 23 条、窗口开始前的历史 HTTP 500 为 1 条、`error_msg` 非空为 0。该轮发现/采用 17/17，最新内容活动从 12:46:46 推进到 13:25:06，避免内容年龄在后续槽跨过 120 分钟。

15:00 槽在状态读取后确认没有健康来源到期，因而 0 planned、0 attempted；该无源轮仍完成 Cron→HTTP 200/unchanged→durable completed→runtime `lastAttemptAt/lastSuccessAt` 闭环，但没有创建 snapshot、没有改写 report ID、generatedAt 或 dataAsOf。窗口内前两槽 Cron、pg_net 与 durable 均为 2/2 成功，失败、缺槽、重复、running 与链接错配均为 0，最大成功完成间隔 14.993 分钟，run P95/max 28.132 秒；健康 rolling 48/48、eligible backlog=0 保持不变。15:01 时最新内容活动年龄约 96.5 分钟，仍通过 120 分钟门。

15:15 到期的 10 个健康来源全部真实 attempted，planned/attempted 集合一致且状态均推进，0 skipped、0 missing、selected last-run mismatch 0。窗口内前三槽 Cron、pg_net 与 durable 为 3/3 成功（published 2、unchanged/completed 1），失败、缺槽、重复、running、非 JSON body、网络错误和四层错配均为 0；最大成功完成间隔 15.420 分钟，run P95/max 28.695 秒。健康 rolling attempted/succeeded=48/48 与 46/48，eligible backlog=0。该轮发现/采用 26/26，最新内容活动推进到 14:55:00。

15:15 后的确定性队列显示：15:45 将有 10 个健康来源到期，同时 `npr` 熔断到期进入半开；旧默认每轮最多 10 源且按最早 `nextDueAt` 排序，必然在 C4 健康 cadence 与 C5 半开恢复之间挤掉 1 个来源。精确回归测试在旧默认下得到 10/11 并失败。默认 `DAILY_NEWS_MAX_SOURCES` 从 10 提升到 11，直连并发 8、16 秒采集预算和其他边界不变；focused 测试红转绿，完整 unit 134/134、integration 62/62、build 1711 modules 与 tracked/untracked diff check 均通过。deployment `dpl_9WxU6pYDF6uz73jugnADiENW2Nfc` 于 15:20Z Ready 并接管正式 alias，冷读 full/compact/reload/health 同步。

15:30 新 deployment 常规 canary 完成四层闭环，10/10 attempted、0 skipped/missing，28.069 秒。15:45 真实碰撞 canary 同样四层闭环：11 个 planned 全部 attempted，0 skipped、0 missing，整轮 27.854 秒；`npr.lastRunId` 指向该 run，`lastAttemptAt/lastSuccessAt` 均为 15:45:02.153Z，失败计数归零、circuit 清空、next due 推进到 17:15。第五次窗口五个理论槽 Cron、pg_net 与 durable 为 5/5 成功，失败、缺槽、重复、running 和错配均为 0，run P95/max 28.695 秒，最大成功完成间隔 15.420 分钟；49/49 enabled 来源滚动 attempted、eligible backlog=0。由于最终代码在窗口中途变化，本窗口不计为最终版本连续 24 小时证据，而不是把新旧 deployment 拼接后宣称通过。

## 第六次 24 小时 burn-in（未失败，但被同 commit production deployment 取代）

原窗口固定为 `2026-07-15T15:45:33.605Z` 至 `2026-07-16T15:45:33.605Z`，起点基线来自 `dpl_9WxU6pYDF6uz73jugnADiENW2Nfc`。Vercel 于 `2026-07-15T15:56:58Z` 又开始构建 production deployment `dpl_GFixDDM6FS1MHrohLLjce72p8X3w`，构建日志明确克隆 `main` 的 commit `1da2f89`、复用前一 deployment 缓存并成功构建 1711 modules；它在约 15:57:26Z Ready 后接管正式 alias。应用代码没有变化，但同一 deployment 的连续性已中断，因此不能把 15:45 基线与后续时槽拼接成 24 小时证据。

新 deployment 的 16:00 首轮完成四层闭环：run `8d984dc9-4c95-4068-88e7-d40de3e187a4` 在 28.137 秒内发布 report `fbc0023b-2048-44fb-859d-e258c4e43b3a`，10/10 attempted、0 skipped/missing，发现/采用 4/4；49/49 enabled 来源 rolling attempted 覆盖且 eligible backlog=0。该轮因此成为第七次窗口的起点基线。

## 第七次 24 小时 burn-in（失败）

窗口固定为 `2026-07-15T16:00:31.819Z` 至 `2026-07-16T16:00:31.819Z`。16:00 run 的真实完成时间是起点基线，首个严格槽为 16:15Z；整个窗口固定在 `dpl_GFixDDM6FS1MHrohLLjce72p8X3w`。这只表示重新计时，不表示 24 小时已通过。

| 时槽 | Cron / pg_net | Durable | 来源 planned/attempted/skipped/missing | 耗时 | 结果 |
| --- | --- | --- | --- | ---: | --- |
| 16:15 | succeeded / HTTP 200 published | `fd45f7cf-3c3a-49e3-9525-2c76d3043024` published | 8/8/0/0 | 27.574s | report `2d82913a-d19f-4031-8579-a5e4717bf357` |
| 16:30 | succeeded / HTTP 200 unchanged | `5c33040a-0671-417b-801a-ef77a251c0f4` completed | 0/0/0/0 | 3.852s | 无来源到期；保留 16:15 report |
| 16:45 | succeeded / HTTP 200 published | `5134d585-ee1b-44fc-9581-66101ef7f78b` published | 10/10/0/0 | 29.573s | report `8da21189-ae0e-481b-8406-8ea046e66e53` |
| 17:00 | succeeded / HTTP 200 published | `d52942a7-1b0d-4a49-ba73-1de8f3bdc4b1` published | 10/10/0/0 | 29.626s | report `b727303c-0692-40c8-acc5-af10b2551ec6` |
| 17:15 | succeeded / HTTP 200 published | `51cbad4a-e6f4-414e-a9c9-05d44efad57b` published | 11/11/0/0 | 29.507s | report `5c8528b3-7967-4c41-8e9a-a9a1ab16bb8b` |
| 17:30 | succeeded / HTTP 200 published | `b43ffb11-7655-4318-abc4-8ec6d70d5253` published | 10/10/0/0 | 31.419s | report `3ef2379d-ebd7-486d-a308-4b3d17c5b2c6`；性能预警 |
| 17:45 | succeeded / HTTP 200 published | `09999af7-da6d-4881-820d-6db96bde6dec` published | 7/7/0/0 | 29.502s | report `63fd2d8e-17e2-4914-9832-9ce931352e69` |
| 18:00 | succeeded / HTTP 200 unchanged | `e5017dcf-c882-4c5e-8471-a62e286e91ad` completed | 0/0/0/0 | 3.050s | 无健康来源到期；保留 17:45 report |
| 18:15 | succeeded / HTTP 200 published | `9ef4f313-dfd1-401b-9652-daff599bb051` published | 10/10/0/0 | 28.062s | report `c95567b0-8705-4590-95bf-b4d0e9c0a134`；最新活动推进至 17:38:54Z |
| 18:30 | succeeded / HTTP 200 published | `5ea4fabf-08a9-4df8-bef5-c2675fc3c11c` published | 9/9/0/0 | 27.977s | report `a683b195-d905-48cb-9678-9fca42dc3239` |
| 18:45 | succeeded / HTTP 200 published | `9e7e3173-780f-4f9d-8536-8384943b310f` published | 11/11/0/0 | 29.529s | report `2eb423e2-3850-40d2-b891-c778a08ad3eb` |
| 19:00 | succeeded / HTTP 200 published | `49ffb345-64e4-42cf-bca9-c98e485e9f19` published | 10/10/0/0 | 29.183s | report `6de30e06-a8e8-4b94-9305-7259d4214e65` |
| 19:15 | succeeded / HTTP 200 published | `45af9ad6-abfc-4067-b375-e221b39ba893` published | 8/8/0/0 | 29.628s | `the-paper` 半开成功；report `6efc5143-9b33-48be-bc45-b4a4974b5ee4` |
| 19:30 | succeeded / HTTP 200 unchanged | `ea49e695-bc67-4a89-8549-291942af6242` completed | 0/0/0/0 | 3.684s | 无健康来源到期；保留 19:15 report |
| 19:45 | succeeded / HTTP 200 published | `d724e6f2-eccd-4bf6-aa2e-f4897ee062de` published | 10/10/0/0 | 29.583s | report `378cd1a7-d111-41b6-b047-02bcc0a78db7` |
| 20:00 | succeeded / HTTP 200 published | `5454614d-e4cb-4521-b0e7-eeb9064bd989` published | 10/10/0/0 | 29.013s | `openai` 半开成功；report `e670a8f2-7596-49a7-9529-4d0d30c14f67` |
| 20:15 | succeeded / HTTP 200 published | `f80746af-7eb1-476f-9cb4-c68d69541b6e` published | 11/11/0/0 | 29.063s | `npr` 第三次 timeout 后按规则 open；report `781f57da-191d-4f56-b52c-5117fb792c3c` |
| 20:30 | succeeded / HTTP 200 published | `2f3ceec0-27e0-4c45-a929-164d139398b3` published | 10/10/0/0 | 29.508s | report `cb0f4d62-3733-4039-8af0-db022bba7fed` |
| 20:45 | succeeded / HTTP 200 published | `2b5a2900-92c2-47a9-888d-47474085d748` published | 8/8/0/0 | 29.481s | report `ae7c73f5-8b68-4fd9-a5be-43b8af76700c` |
| 21:00 | succeeded / HTTP 200 unchanged | `6a4d1117-afaf-4032-8a1c-d9a3054bdbd2` completed | 0/0/0/0 | 3.254s | 无健康来源到期；保留 20:45 report |
| 21:15 | succeeded / HTTP 200 published | `2223f864-52e4-41af-87ea-abfb87c11b7f` published | 10/10/0/0 | 29.713s | report `17e4a5f2-5c1c-4e78-b543-2229565f97ea` |
| 21:30 | succeeded / HTTP 200 published | `761212e9-0055-48b6-9a51-e6114b4978a9` published | 10/10/0/0 | 30.148s | 第二个慢样本；report `af7e71a0-7ef4-4a51-b361-c9392cd8c4b2` |
| 21:45 | succeeded / HTTP 200 published | `e4753f56-8563-4257-ae66-2ce11ac45785` published | 10/10/0/0 | 28.426s | report `8b6e7c5a-20b0-4d59-83b9-662f707b39d9` |
| 22:00 | succeeded / HTTP 200 published | `b7817567-51cb-4e12-9eb2-ceafac03d03e` published | 10/10/0/0 | 30.872s | 第三个慢样本；report `bbdce38c-61d8-4588-af4e-87bc18a885e2` |
| 22:15 | succeeded / HTTP 200 published | `3da1909f-a002-4089-99c6-e7972fb9eb17` published | 8/8/0/0 | 32.930s | 第四个慢样本并刷新窗口 max；report `ac75fe49-dec9-4770-a982-6bdf8f23e3e6` |
| 22:30 | succeeded / HTTP 200 unchanged | `1fad513a-5695-448f-89fb-5ef45ab7b861` completed | 0/0/0/0 | 3.114s | 无健康来源到期；保留 22:15 report |
| 22:45 | succeeded / HTTP 200 published | `4061c20b-4eaf-45f7-bbe6-6b82124a077c` published | 10/10/0/0 | 30.996s | 第五个慢样本，完整窗口 P95 自此不可恢复；report `264fa59f-6463-422f-a689-665bbff39941` |
| 23:00 | succeeded / HTTP 200 published | `f46c7fa1-2c53-4550-b690-6c102c5a8a64` published | 10/10/0/0 | 30.226s | 第六个慢样本；`openai` 累计第二次 access denied；report `274c1a4f-aeb4-4719-be4f-810e36094e6f` |
| 23:15 | succeeded / HTTP 200 published | `73e94a10-840c-4894-91d9-31eaa80e84e0` published | 11/11/0/0 | 30.265s | 第七个慢样本；`npr` 真实半开 timeout 后重开；report `08236df0-66b3-45e7-9e79-c7a6ec76f404` |
| 23:30 | succeeded / HTTP 200 published | `099d723e-230a-4001-8b77-e7deb64f21cf` published | 10/10/0/0 | 29.719s | report `2de2d661-f46c-407f-b484-4a4f536af026` |

截至 23:30Z，理论/实际严格槽为 30/30；Cron 30/30 succeeded，durable 30/30 成功（25 published、5 completed）。逐小时已经保存的 pg_net 证据覆盖全部 30 槽且均为 HTTP 200；由于 `pg_net.ttl=6 hours`，23:31 只还能在线查询最近 24 槽（20 published、4 unchanged），这 24/24 条仍全部为 HTTP 200、`error_msg` 为空并与 durable run 一一匹配，最早六个严格槽的响应已按预期过期而不是缺槽。失败、缺槽、重复、running、非 JSON body、网络错误、run ID 与四层链接错配均为 0；242 planned 全部真实 attempted，skipped/missing=0，最大成功完成间隔 15.446 分钟。

窗口共有 7/30 个大于 30 秒的轮次：17:30 为 31.419 秒、21:30 为 30.148 秒、22:00 为 30.872 秒、22:15 为 32.930 秒、22:45 为 30.996 秒、23:00 为 30.226 秒、23:15 为 30.265 秒；最近秩 P95 为 31.419 秒，max 为 32.930 秒。正式硬门是完整 96 槽 P95 不超过 30 秒，最终最多只能容纳 4 个慢样本；22:45 的第 5 个慢样本已经使完整窗口 P95 数学上不可恢复，因此第七次窗口在该槽失败，后续三个槽只作为诊断证据，不能挽回或拼接到下一窗口。

23:40 审计为 enabled 49、healthy 48、circuit-open 1、half-open 0；健康来源 rolling attempted/succeeded=48/48 与 46/48，missing attempted ID 为空，eligible backlog=0。`npr` 在 23:15 真实半开并计入 11/11 attempted，但第四次连续 timeout 后重开至 `2026-07-16T02:15:01.525Z`，符合 C5；`openai` 23:00 真实 attempted 后累计 2 次 `source_access_denied`，仍未熔断且下次 00:30 到期；`the-paper` 当前连续失败 2 次且 23:45 到期。任何 skipped 都不得推进来源状态。

慢轮阶段证据显示，22:45、23:00、23:15 从 durable started 到候选 upsert 分别约 20.846/20.361/20.449 秒，upsert 到原子发布分别约 10.149/9.865/9.817 秒。后段约 10 秒与 Supabase read 的 4 秒 attempt timeout、250/750ms 两次退避和第三次成功的时间指纹高度吻合；数据库 `pg_stat_statements` 对相关 RPC 的历史最大 SQL 时间仅约 97–180ms，因此证据不支持 SQL 本身缓慢。由于生产没有分阶段 timing/retry 日志，不能把具体每次 retry 当作直接观测事实，但可以确定 16 秒采集预算没有为租约后的持久读取重试、报告构建与发布留下稳定余量。

最小修复把 `defaultCollectionBudgetMs` 从 16 秒降至 12 秒，保持 `maxSources=11`、直连并发 8、单请求上限、读重试与质量门不变。真实 23:15 cohort 的不写数据库 canary 在 12.007 秒内产生 11/11 source outcomes、0 skipped、6 个候选；按本窗口最慢 32.930 秒回收 4 秒后约为 28.930 秒。默认值与显式 override 回归通过；完整 unit 136/136、integration 64/64、build 1711 modules 和 `git diff --check` 均通过。必须部署并以真实 Cron 四层 canary 验证后才可建立第八次窗口基线。

## 第八次 24 小时 burn-in（失败）

窗口固定为 `2026-07-15T23:45:29.357Z` 至 `2026-07-16T23:45:29.357Z`。生产 alias 已明确绑定 `dpl_4nAPHWn6LxkvfQ3Ksqn6PhFCZ3mR`，Vercel deployment metadata 确认 commit `8528fb518dc3bc7087758acc452758fe0cec9cab`；23:45 自然 Cron 的 durable 完成时间是起点基线，首个严格槽为 00:00Z。这只表示重新计时，不表示 24 小时已通过。

| 时槽 | Cron / pg_net | Durable | 来源 planned/attempted/skipped/missing | 耗时 | 结果 |
| --- | --- | --- | --- | ---: | --- |
| 23:45 基线 | succeeded / HTTP 200 published | `1dbb219f-c70b-42e9-9dda-2d159f63d537` published | 8/8/0/0 | 25.711s | report `b3c4ef36-5fa7-439a-837f-bbd849238d25`；12 秒预算首个生产 canary |
| 00:00 | succeeded / HTTP 200 unchanged | `33a0730a-237f-4e25-b623-0e9b01a131fc` completed | 0/0/0/0 | 3.529s | 无来源到期；保留 23:45 report |
| 00:15 | succeeded / HTTP 200 published | `3e6707c3-c11e-4709-9261-fcc21d5dd596` published | 10/9/1/0 | 27.110s | `people` deadline skipped，C4 cadence 失败；report `e630372e-47bd-437c-ab53-6be6ee252388` |
| 00:30 | succeeded / HTTP 200 published | `16043319-809c-4435-8405-a71082978278` published | 11/11/0/0 | 26.182s | `people` 下一槽补跑；`openai` 第三次 access denied 后 open；report `10937f2d-b4c7-4b11-a257-e93f5aa0fd73` |

该轮 Cron job run `246`、pg_net response `248`、durable run、snapshot 与 runtime latest 的 run/report ID 全部一致；失败、重复、running、非 JSON body、网络错误和原子链接错配均为 0。8 个 planned 来源全部真实 attempted，发现/采用 11/11；`the-paper` 第三次 `source_access_denied` 后按规则 open 至 `2026-07-16T02:45:01.035Z`，没有被伪装进健康分母。基线后 enabled 49、healthy 47、circuit-open 2、half-open 0；健康来源 rolling attempted/succeeded=47/47 与 46/47，missing attempted ID 为空，eligible backlog=0。另一个 open 来源 `npr` 等待 02:15 半开。完整 `pg_net.ttl=6 hours` 保留 24 条响应，24/24 HTTP 200、`error_msg` 非空为 0。

新 deployment 与 alias API 均确认 production 正式指向 `dpl_4nAPHWn6LxkvfQ3Ksqn6PhFCZ3mR`。23:47 公开门中 health/full/compact/reload 同步到 23:45 report，合法端点均为 200、invalid query 为 400，缓存契约全部通过；report 年龄 2.44 分钟，候选/首页活动年龄 46.56/67.79 分钟，重复为 0，核心 27/27 confirmed，`maxPrimaryPublisherShare=0.111`，10/10 分类覆盖。

三个严格槽的 Cron、pg_net、durable 与 snapshot/runtime 均为 3/3 闭环（published 2、unchanged/completed 1），失败、缺槽、重复、running、非 JSON body、网络错误和原子链接错配均为 0；21 planned、20 attempted、skipped 1、missing 0，run P95/max 为 27.110 秒，最大成功完成间隔 15.390 分钟。性能修复有效，但 00:15 的 `people` 从 22:45:01.544Z 到 00:30:01.665Z 才再次真实 attempted，间隔约 105.002 分钟。它在 00:15 仍为健康且已 due，skipped 不推进状态；即使 00:30 按 oldest-due 优先补跑并恢复当前 rolling 46/46，也不能抹掉 00:15 至 00:30 的 C4 覆盖缺口，因此第八次窗口在 00:15 失败。

根因是 12 秒预算缩短后，直连默认并发 8 仍小于单轮最多 11 个 selected sources；00:15 cohort 的前 8 个 worker 没有足够早释放第二批，导致排在第 10 位的 `people` 未开始。生产没有 `DAILY_NEWS_SOURCE_CONCURRENCY` override。最小修复把默认并发从 8 提升至 11，使所有 selected sources 一开始即获得 worker，保持 12 秒预算、maxSources 11、单请求上限、熔断与质量门不变。exact 00:15 cohort 的不写数据库 canary 在 12.010 秒内产生 10/10 outcomes、0 skipped、23 个候选；barrier 回归证明 11/11 任务在释放前全部启动。完整 unit 136/136、integration 64/64、build 1711 modules 与 `git diff --check` 均通过；修复随后完成部署，并由 00:45 自然 Cron canary 建立第九次窗口基线。

## 第九次 24 小时 burn-in（未通过：证据不完整）

窗口固定为 `2026-07-16T00:45:30.446Z` 至 `2026-07-17T00:45:30.446Z`。生产 alias 已明确绑定 READY production deployment `dpl_DFgdwpoPUfPe8UGnJVGLexDGhRKY`，Vercel metadata 确认 commit `094fb36328770293952d3718264244eaac9e78fe`；00:45 自然 Cron 的 durable 完成时间是起点基线，首个严格槽为 01:00Z。这只表示重新计时，不表示 24 小时已通过。

| 时槽 | Cron / pg_net | Durable | 来源 planned/attempted/skipped/missing | 耗时 | 结果 |
| --- | --- | --- | --- | ---: | --- |
| 00:45 基线 | run 250 succeeded / response 252 HTTP 200 published | `28fe6768-d4d2-42b1-ad87-50f41ff3b604` published | 10/10/0/0 | 25.987s | report `175cb675-cdd8-4f55-b827-d7c84a714471`；并发 11 首个自然生产 canary |
| 01:00 | run 251 succeeded / response 253 HTTP 200 published | `831e76e0-3f36-48a2-9240-956309c37831` published | 10/10/0/0 | 26.216s | 发现/采用 4/4；report `10754128-394e-4957-9faa-3a9f97fae8d7` |
| 01:15 | run 252 succeeded / response 254 HTTP 200 published | `55b780e1-1311-4e60-8c83-40104153a2ef` published | 7/7/0/0 | 26.081s | 发现/采用 11/11；report `ef7aa86e-1019-48d9-a5b8-15217e019bf6` |
| 01:30 | run 253 succeeded / response 255 HTTP 200 unchanged | `74d230e9-a18a-4e87-bc02-d94eaf09731a` completed | 0/0/0/0 | 3.642s | 无健康来源到期；runtime 正确保留 01:15 report |
| 01:45 | run 254 succeeded / response 256 HTTP 200 published | `ce954fc5-c6e9-4cc4-b8db-8f84415006a3` published | 9/9/0/0 | 25.570s | 发现/采用 20/20；report `1cc149b2-5da1-491d-af1e-7bc286120437` |
| 02:00 | run 255 succeeded / response 257 HTTP 200 published | `027b0637-fcfa-4148-a75c-e209f5896d3a` published | 10/10/0/0 | 25.138s | `people` 正常再尝试；report `f2b97ef1-245f-467a-956d-9b06076d1c60` |
| 02:15 | run 256 succeeded / response 258 HTTP 200 published | `6d2a8e5c-d244-4482-bc95-0fb38ccb37d6` published | 11/11/0/0 | 25.698s | 自然满载；`npr` 半开 timeout 后按 C5 重开；report `1fd92604-407f-4fe0-a403-2ef3332ad7d5` |
| 02:30 | run 257 succeeded / response 259 HTTP 200 published | `30399d8b-2423-415a-a639-57552b747f28` published | 10/10/0/0 | 25.422s | 发现/采用 4/4；report `38efbd6a-1c79-493f-890e-fcbb4375c3ef` |
| 02:45 | run 258 succeeded / response 260 HTTP 200 published | `d07eaed8-7f30-415c-ab1e-9046b79ec5d7` published | 8/8/0/0 | 25.454s | `the-paper` 半开 access denied 后按 C5 重开；report `b668012e-eab8-4d52-930d-3f1cad0b39b9` |
| 03:00 | run 259 succeeded / response 261 HTTP 200 unchanged | `6908617e-c6d7-4391-a5bd-e9f13dc5e154` completed | 0/0/0/0 | 3.656s | 无健康来源到期；runtime 正确保留 02:45 report |
| 03:15 | run 260 succeeded / response 262 HTTP 200 published | `afef1752-2178-4466-8bb6-6a5f3849a3f7` published | 9/9/0/0 | 25.622s | 发现/采用 18/18；report `73048a3a-47e5-4908-ad82-b7d5dc7984c3` |
| 03:30 | run 261 succeeded / response 263 HTTP 200 published | `2ba666d9-6dce-4658-87a1-9796d1dc8617` published | 11/11/0/0 | 26.187s | `openai` 半开成功并清空 circuit；report `f096ba61-a250-4661-a5b0-ec4bf6313076` |
| 03:45 | run 262 succeeded / response 264 HTTP 200 published | `9ad2f762-a65f-4656-9ccf-dcf5f1d49bd6` published | 10/10/0/0 | 24.951s | 发现/采用 5/5；report `7ceff71d-04b1-4e72-8889-9a017ef5dacb` |
| 04:00 | run 263 succeeded / response 265 HTTP 200 published | `c6cc49d2-4228-4471-a4d7-c447c70a612d` published | 10/10/0/0 | 25.874s | 发现/采用 5/5；report `29503e48-3906-4530-9b7b-9e93aa7912ca` |
| 04:15 | run 264 succeeded / response 266 HTTP 200 published | `8f5d3c81-3faa-4b69-903a-d6d257008d37` published | 7/7/0/0 | 25.667s | 发现/采用 11/11；report `7c602aa1-ef83-413e-b2e8-e0af929b50ca` |
| 04:30 | run 265 succeeded / response 267 HTTP 200 unchanged | `a00ab3fd-357a-4d22-8f1a-9094283d0ab0` completed | 0/0/0/0 | 3.090s | 无健康来源到期；无 snapshot，runtime 正确保留 04:15 report |
| 04:45 | run 266 succeeded / response 268 HTTP 200 published | `68063b3d-a9f9-4103-a719-334201e43ff9` published | 9/9/0/0 | 25.571s | 发现/采用 17/17；report `5f824d22-3e96-46ce-9de5-ade7fe209a50` |
| 05:00 | run 267 succeeded / response 269 HTTP 200 published | `9fed52e5-2949-483b-a58a-df242f6fcfa7` published | 11/11/0/0 | 24.212s | `openai` 一次 access denied，未熔断；report `3b71a794-0ce6-4f7f-b341-d71490d288ab` |
| 05:15 | run 268 succeeded / response 270 HTTP 200 published | `d5f10755-9a9b-4c27-b6bf-d452a390fadf` published | 11/11/0/0 | 24.949s | `npr` 真实半开成功并清空 circuit；report `c2e3a51d-00d4-4a90-a9a5-f8756b120f60` |
| 05:30 | run 269 succeeded / response 271 HTTP 200 published | `221ec416-dafe-4577-bbbf-4513521c023a` published | 10/10/0/0 | 24.898s | 发现/采用 5/5；report `b1955cd5-b99e-44cf-82fa-5912819460ac` |
| 05:45 | run 270 succeeded / response 272 HTTP 200 published | `addaccea-5ea7-43f7-a7ab-b9fdc9727c4c` published | 8/8/0/0 | 24.927s | `the-paper` 真实半开成功并清空 circuit；发现/采用 9/9；report `546a025e-ac4b-413c-9a69-2a3a0e92193a` |
| 06:00 | run 271 succeeded / response 273 HTTP 200 unchanged | `76746a73-1517-40e5-949e-825fd3877281` completed | 0/0/0/0 | 3.106s | 无健康来源到期；无 snapshot，runtime 正确保留 05:45 report |
| 06:15 | run 272 succeeded / response 274 HTTP 200 published | `97db2759-2c6b-4d50-af87-8c93e3101dca` published | 9/9/0/0 | 23.253s | 发现/采用 22/22；内容活动推进到 05:51；report `854a2819-399c-41c8-985f-2f8018dcc9b8` |
| 06:30 | run 273 succeeded / response 275 HTTP 200 published | `680b4a19-6595-4dcf-ae49-eacde470f259` published | 11/11/0/0 | 25.375s | 自然满载 11 源全部启动；发现/采用 15/15；report `2e1c330b-8371-4b98-945e-f59ee264119c` |
| 06:45 | run 274 succeeded / response 276 HTTP 200 published | `600fc3a0-c53b-481d-90f9-2c42c6760300` published | 11/11/0/0 | 24.486s | 第二个自然满载 11 源全部启动；发现/采用 12/12；report `ab828efb-9329-4b73-ba34-9a721703c0bd` |
| 07:00 | run 275 succeeded / response 277 HTTP 200 published | `15ddde0e-8fcb-4daa-8669-e2b01c07c693` published | 10/10/0/0 | 24.283s | 发现/采用 4/4；report `129dcbcf-f7a9-4e7f-8912-f43b6b037e12` |
| 07:15 | run 276 succeeded / response 278 HTTP 200 published | `6a8d1d1f-1458-416e-8d3e-bc39c27514c5` published | 8/8/0/0 | 23.942s | 发现/采用 10/10；内容活动推进到 06:34:35；report `68f0ddde-651d-418c-8678-de09ef9c08c5` |
| 07:30 | run 277 succeeded / response 279 HTTP 200 unchanged | `f5742bc7-2b28-4659-8721-35edf120c4b8` completed | 0/0/0/0 | 3.014s | 无健康来源到期；无 snapshot，runtime 时间推进并正确保留 07:15 report |
| 07:45 | run 278 succeeded / response 280 HTTP 200 published | `198409fe-57cb-4a7a-919e-3c63a0b23559` published | 9/9/0/0 | 24.952s | `aljazeera`/`cnbc` 均真实 attempted 且成功；发现/采用 16/16；report `7c368a9f-f452-4e1f-9e1e-9b33da6a42af` |
| 08:00 | run 279 succeeded / response 281 HTTP 200 published | `0a3efe3a-5fbb-4f56-8b9e-af3c97262e9f` published | 11/11/0/0 | 24.655s | `openai` 第三次 access denied 后按 C5 熔断至 11:00；发现/采用 6/6；report `9e329c76-e405-420d-b21b-c7a2ac0a0b96` |
| 08:15 | run 280 succeeded / response 282 HTTP 200 published | `99fcde52-a014-4576-b455-1585c68b81d2` published | 11/11/0/0 | 24.306s | `npr` 第二次 timeout 未达熔断阈值；`hugging-face` 首次 timeout；发现/采用 6/6；report `a44365a3-86f2-4e3c-ba7a-d16e8be46240` |

基线的 Cron、pg_net、durable、snapshot 与 runtime latest 五层标识完全一致；pg_net body 的 9 个键精确符合 refresh response 白名单，unexpected/missing 均为 0，网络错误、失败、重复、running 和原子链接错配均为 0。10 个 planned 来源全部真实 attempted，planned-not-attempted 与 attempted-not-planned 均为空，10 条 `source_state.last_run_id` 均指向本 run，发现/采用 11/11。该自然槽只有 10 个来源到期，因此它验证 selected 10/10 全部启动；11-source 满载仍由部署前不写数据库的真实 11/11 canary 与 barrier 回归承担，不能把本槽夸大为 11-source 自然碰撞。

截至 08:15Z，理论/实际严格槽为 30/30；Cron、durable 与逐槽保存的 pg_net 证据均覆盖 30/30，durable 25 published、5 completed，失败、缺槽、重复、running、非 JSON body、网络错误和原子链接错配均为 0。241 planned 全部真实 attempted，skipped/missing=0；nearest-rank P95 为 26.187 秒、max 为 26.216 秒，>30 秒样本 0，含基线的最大成功完成间隔 15.374 分钟。由于 `pg_net.ttl=6 hours`，08:16 在线表只保留最近 24 条响应；24/24 均为 HTTP 200、9 键精确白名单且与 durable 匹配，最早六条按预期自然过期而不是缺槽。五次 unchanged 都没有创建无意义 snapshot；08:15 runtime、snapshot 与 report 已原子推进到同一目标。

### 第九次窗口最终结论

第九次窗口要求 96 个严格槽逐槽同时具备 Cron、pg_net HTTP/body、durable run 和 snapshot/runtime latest 证据。当前可核验材料只覆盖 01:00Z 至 08:15Z 的 30/96 个槽；08:30Z 至次日 00:45Z 的 66 个槽没有在 pg_net 的 6 小时 TTL 内保存聚合证据，且当时的任务记录没有实际查询输出或独立落盘。后续只查 Cron 或 durable 不能重建已经过期的 HTTP/body 白名单证据，因此该窗口结论是“验收证据不完整、不能判通过”，不是把 30 个已通过槽外推为 96 个槽，也不是把后续旧 deployment 数据拼接到新窗口。

02:15 是并发 11 修复后的首个自然满载生产槽，11 个 planned 来源全部真实 attempted，planned-not-attempted、attempted-not-planned、skipped 和 missing 均为空；它补齐了此前只由 canary 与 barrier 回归承担的满载生产证明。`npr` 在 circuit 到期后明确进入 planned/attempted 集合，本次再次 `source_timeout`，`lastAttemptAt=02:15:02.049Z`、`lastRunId` 指向本 run、连续失败升至 5，circuit 正确重开至 05:15:02.049Z，符合 C5。05:15 的后续自然满载槽再次把 `npr` 纳入 planned/attempted 且没有 skipped；本次成功后 `lastAttemptAt=lastSuccessAt=05:15:01.549Z`，连续失败、错误与 circuit 全部清空，next due 推进到 06:45，证明半开恢复路径完整闭环。

`the-paper` 在 02:45 明确进入 planned/attempted 集合且未 skipped，本次再次 `source_access_denied`，连续失败升至 4，circuit 正确重开至 05:45:01.480Z；05:45 到期后再次进入 planned/attempted 集合且成功，`lastAttemptAt=lastSuccessAt=05:45:01.453Z`、`lastRunId` 指向本 run，连续失败、错误与 circuit 全部清空，next due 推进到 07:15。`openai` 在 03:30 同样真实半开 attempted，本次成功后 `lastAttemptAt=lastSuccessAt=03:30:01.385Z`，连续失败、circuit 与错误状态全部清空，next due 推进到 05:00。两者均符合 C5。

08:18 审计为 enabled 49、healthy 48、circuit-open 1、half-open 0；本窗口 49/49 enabled 来源均已真实 attempted，健康来源 rolling attempted/succeeded=48/48 与 45/48，missing attempted ID 为空，eligible backlog=0。`openai` 在 08:00 的 11-source 满载槽中真实 attempted，第三次 `source_access_denied` 后 `lastRunId` 指向本 run、circuit 按 C5 正确打开至 11:00:01.551Z；当前按规则排除健康分母。`npr` 在 08:15 同样真实 attempted，第二次 `source_timeout` 后未达三次阈值、circuit 为空、next due 推进到 09:45；`hugging-face` 本轮首次 timeout，circuit 为空且同样等待 09:45。`the-paper` 仍为一次 access denied 并等待 08:45。当前无 due backlog；08:45 必须验证 `the-paper` 真实 attempted，09:45 继续核对 `npr`/`hugging-face`，11:00 必须验证 `openai` 真实半开。

公开页面在未触发手动 refresh 的前提下，于 00:45:48Z 自动收敛到新 deployment 的首个报告。08:21Z 审计中 health/full/compact/reload 均为 200 且同步 08:15 report，invalid query 为 400，缓存契约全部通过；report 年龄约 5.99 分钟，候选/首页最新活动年龄均约 58.17 分钟，按实际内容字段独立计算且不以 generatedAt 代替；重复为 0，核心 25/25 confirmed，`maxPrimaryPublisherShare=0.12`，10/10 分类覆盖。

### 2026-07-18 公开新鲜度硬失败与最小修复

`2026-07-18T06:00Z` 左右，生产 Cron 的 `lastAttemptAt/lastSuccessAt` 已推进到 06:00Z，但 latest report 仍为 `a1ffbfb0-fe0f-4f22-8e8a-5a8251d3d695`、`dataAsOf=2026-07-18T04:15:01.590Z`；`/api/health` 返回 503 stale。full、compact 与 reload 均指向同一冻结报告且没有 CDN HIT，排除了浏览器刷新和边缘缓存。报告候选与首页最新实际活动停在 `2026-07-18T02:55:00Z`，检查时已超过 120 分钟硬门；这证明 generatedAt/lastSuccessAt 不能掩盖旧内容。

直接抽样显示中国新闻网公开首页已有 `2026-07-18T04:38:00Z` 的文章，但旧采集器仍只采用 DOM 前部的 7 月 17 日链接。根因是 `readHtmlLinkCandidates` 保留 DOM 顺序，而直连采集在解析文章时间前先执行每栏目候选截断；首页后部带日期的新链接因此被旧 hero 链接挤出，来源仍会错误地报告 success。最小修复在截断前按页面时间或 URL 日期降序排列候选，无法推断日期的链接保持原有稳定顺序，不改变 12 秒预算、并发 11、来源上限、重试、熔断或质量门。

修复后回归测试覆盖“10 个旧链接位于 1 个新链接之前”的精确场景；完整 unit 137/137、integration 64/64、build 1711 modules 和 `git diff --check` 通过。真实两来源只读 canary 中，央视/中新网分别为 success 7/5，中新网最新候选为 `2026-07-18T04:38:00Z`；真实 11 来源只读 canary 在 4.181 秒内产生 11/11 outcomes、0 skipped、0 missing、42 个候选。修复尚未计入任何旧窗口；必须完成单次生产部署，并由部署后的自然 Cron 四层闭环建立第十次 24 小时窗口。

## 历史内容与首页证据（第九次窗口截至 08:21Z）

- 当前 report `a44365a3-86f2-4e3c-ba7a-d16e8be46240` 共 212 个事件、24 个来源；top/important/watch 为 10/15/8，核心 25 条全部为 confirmed，`dataAsOf=2026-07-16T08:15:01.654Z`。
- 候选池与首页最新活动均为 `2026-07-16T07:22:51Z`，08:21 审计时约 58.17 分钟，低于 120 分钟发布门；report 年龄约 5.99 分钟。
- “实时更新”继续按 evidence/published/updated 的最大活动时间排序；developing 只进入持续关注，不伪装成核心已确认新闻。
- 标题、摘要、标题摘要组合的精确重复均为 0；三个首页层无交叉引用或资格违规。
- 全量 trust 为 high 29、medium 183、low 0，`shouldShow=false` 项 0；全量 212 条均有证据。
- 核心媒体最高占比为 3/25=`0.12`，与报告声明一致，满足核心至少 15 条时不高于 0.2；共享每媒体最多 3 条的绝对上限也满足。全量 321 条证据覆盖 24 个来源，10/10 分类均有覆盖。

## 生产 API smoke

| 检查 | 结果 |
| --- | --- |
| 首页 | 200；正式 alias 已指向新 deployment |
| 完整 `GET /api/news` | 200；当前响应含 212 个 `items`、212 个 `stories` 和完整分区对象，保持 V2/legacy 兼容 |
| compact `view=web&window` | 200；212 个 stories、10/15/8 个分区 ID、212 条 ranking metadata，不含 legacy items；30 秒窗口使用共享缓存 |
| compact `view=web&reload=1` | 200；与 full/compact 的 report ID、dataAsOf、story count 同步；不含 items，浏览器 `Cache-Control: no-store` |
| 非法 cache query | 400 + `no-store`；非规范前导零 window 在读取 durable storage 前拒绝 |
| `GET /api/health` | 08:15 发布后返回 200 fresh、Supabase、`lastError=null`，与 full/compact/reload 指向同一 08:15 report；跨过 30 分钟时仍会如实返回 503 stale |
| 未授权 `GET /api/cron` | 401 |
| 未授权 `POST /api/refresh` | 401 |
| 正确 Cron Bearer | 200，并持续产生上表 durable run/report；基线与 30 个严格槽均为自然 Cron，未使用手动 refresh |
| 冷实例收敛 | 新部署冷读后 8.5 秒内连续三次读到相同 Supabase report，低于 60 秒门槛 |
| latest read 性能 | 发布门历史压测：完整约 75 KB gzip 响应 P95 `988.0 ms`、P99 `1619.9 ms`，未过门；改用约 32.9 KB compact 后，固定窗口 100 请求、并发 5、错误 0：P50 `377.1 ms`、P95 `671.8 ms`、P99 `961.5 ms`，通过 P95 ≤750 ms、P99 ≤1 s |
| 浏览器 | 1720px 与 390×844 均无横向溢出；compact 水合出完整事件、实时更新与四个时间字段；慢 reload 在 8 秒后释放按钮；11:27 已打开页面在 11:30:31 发布后于 11:31:22 看到新 report，观测上限 51 秒 |
| 回滚演练 | current→previous→bootstrap stale→current 恢复均成功；API 观察收敛 5.769 秒，恢复 4.285 秒 |
| 同槽幂等 | 首个真实 Cron 同槽再次请求返回 202/duplicate，引用相同 run，无第二次发布 |

## 尚未关闭的验收项

- 独立 staging 与真实数据库 20 候选并发 upsert、10 lease 竞争、发布 failpoint 仍是后续 migration 的硬化缺口；当前生产 pgTAP、fencing、同槽 duplicate 与回滚已覆盖主链路。
- 第八次窗口已在 00:15 因健康来源 cadence 缺口判定失败；第九次窗口只有前 30/96 个严格槽保存了完整四层证据，剩余 66 个槽的 pg_net 证据已过期且未独立落盘，因此不能判通过。
- `2026-07-18` 公开门确认 latest report 冻结、实际内容活动超过 120 分钟；直连 HTML 候选排序修复必须部署并重新起算第十次窗口。
- 完成 7 天 soak：调度成功率、报告年龄 P95、来源 cadence、source-to-site 延迟与内容质量抽样。

发布门曾通过，但当前内容新鲜度门失败；第九次窗口因不可恢复的证据缺口不能判通过。当前 Codex 任务保持每小时检查，候选排序修复部署后必须从新的自然 Cron 基线重新开始第十次 24 小时窗口；只有完整窗口通过后才调整为每日检查并进入 7 天 soak。任何内容、性能、权限或调度硬门失败都先停止新增调度或回到 last-known-good，再按 [release-plan.md](release-plan.md) 重验。
