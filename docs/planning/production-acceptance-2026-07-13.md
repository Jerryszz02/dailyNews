# Supabase 生产验收记录（2026-07-13）

## 当前结论

状态：**前四次 24 小时 burn-in 均未通过；第五次窗口本身未触发硬失败，但因半开容量修复在窗口中途部署而不再能证明最终版本连续运行；11-source canary 通过后，第六次窗口从 `2026-07-15T15:45:33.605Z` 起算**。

Supabase 持久化、两次生产迁移、Vercel 读取、受保护刷新和 15 分钟 Supabase Cron 已部署。最终代码包含 16 秒采集预算、有界只读重试、deadline 来源公平、首页活动时间门、核心媒体共享配额、compact 网页响应与分层 Vercel 边缘缓存。`2026-07-13T11:31:22Z` 起的首次 24 小时窗口暴露了 Supabase 瞬时只读失败导致的丢槽、来源 cadence 和单轮耗时问题；`2026-07-15T09:45:31.765Z` 起的第二次窗口在首个严格窗口内时槽暴露了 4 毫秒到期边界漏选；从 `11:30:18.775Z` 起的第三次窗口又在 `12:00Z` 因两个健康来源 deadline skipped 违反 C4。默认直连并发从 6 提升到 8 后，来源恢复门通过，第四次窗口从 `13:00:18.723Z` 起算；但 13:30 Cron 的 Supabase `readState` 收到单次 `PGRST303`，HTTP 500 且未创建 durable run，窗口在第二槽失败。只读重试补充该网关 claim 解析错误后来源 cadence 恢复，第五次窗口从 14:30 起算；随后又在 15:45 前识别出“10 个健康 cohort + 1 个半开来源”必然争用旧 10-source 上限。默认上限提升为 11 并通过真实 11-source canary 后，为保证连续 24 小时只覆盖同一最终版本，现从该 canary 完成时间重新起算第六次窗口。24 小时与随后 7 天 soak 完成前，仍不能把本记录解释为“实时更新最终验收完成”。

## 发布标识

| 项 | 值 |
| --- | --- |
| 基线 Git commit | `73da3e4c04fb977e7df919e8a561a02b072f6592`；部署包含尚未提交的工作区改动 |
| migration | `20260713090000_daily_news_store.sql`、`20260713101500_runtime_hardening.sql`；local/remote list 一致且无 pending dry-run |
| bootstrap report | `ec5f550b-69ee-4324-bac7-143ef5d2e86b`，保留原始 `dataAsOf=2026-07-09T15:39:06.365Z` |
| production deployment | 当前 `dpl_9WxU6pYDF6uz73jugnADiENW2Nfc`；`PGRST303` deployment 为 `dpl_FhVWbvoHb8M85jWFFXS7DNLLKEB5`，并发 8 deployment 为 `dpl_42GxM5xXz99nCsV4DaZvRiHVJeMy` |
| production alias | `https://daily-news-tau-taupe.vercel.app` |
| cron job | `jobid=2`，`daily-news-refresh`，`*/15 * * * *`，active；重装后首个时槽 `2026-07-13T10:45:00Z` 已闭环 |

本记录只保存公开 URL、标识符和聚合结果；不保存 Supabase、Vercel、Cron、刷新或翻译凭据。

## 确定性与数据库证据

| 检查 | 结果 |
| --- | --- |
| `npm test` | 半开容量回归补强后通过：14 个文件、134 个测试 |
| `npm run test:integration` | 通过：7 个文件、62 个测试 |
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

## 第六次 24 小时 burn-in（进行中）

窗口固定为 `2026-07-15T15:45:33.605Z` 至 `2026-07-16T15:45:33.605Z`。15:45 的 11-source canary 是起点基线，首个严格槽为 16:00Z。起算时 deployment 已固定为 `dpl_9WxU6pYDF6uz73jugnADiENW2Nfc`，Cron/pg_net/durable/snapshot/runtime 四层原子，49/49 健康来源 rolling 覆盖、eligible backlog=0，公开内容/API 门通过。这只表示重新计时，不表示 24 小时已通过。

## 内容与首页证据

- 当前 report `8c41bb42-1b78-4187-aba8-f882e849ef0c` 共 206 个事件、25 个来源；top/important/watch 为 10/15/8，核心 25 条全部为 confirmed，`dataAsOf=2026-07-15T15:45:02.153Z`。
- 候选池与首页最新活动均为 `2026-07-15T15:17:10Z`，15:46 审计时约 29.6 分钟，低于 120 分钟发布门。
- “实时更新”继续按 evidence/published/updated 的最大活动时间排序；developing 只进入持续关注，不伪装成核心已确认新闻。
- 标题、摘要、标题摘要组合的精确重复均为 0；三个首页层无交叉引用或资格违规。
- 全量 trust 为 high 28、medium 178、low 0，`shouldShow=false` 项 0；核心 high 11、medium 14。
- 核心媒体最高占比为 3/25=`0.12`，与报告声明一致，满足核心至少 15 条时不高于 0.2；共享每媒体最多 3 条的绝对上限也满足。全量证据来源 25 个、核心证据来源 16 个、核心主发布方 12 个，10/10 分类均有覆盖。

## 生产 API smoke

| 检查 | 结果 |
| --- | --- |
| 首页 | 200；正式 alias 已指向新 deployment |
| 完整 `GET /api/news` | 200；当前响应含 206 个 `items`、206 个 `stories` 和完整分区对象，保持 V2/legacy 兼容 |
| compact `view=web&window` | 200；206 个 stories、10/15/8 个分区 ID、206 条 ranking metadata，不含 legacy items；30 秒窗口使用共享缓存 |
| compact `view=web&reload=1` | 200；与 full/compact 的 report ID、dataAsOf、story count 同步；不含 items，浏览器 `Cache-Control: no-store` |
| 非法 cache query | 400 + `no-store`；非规范前导零 window 在读取 durable storage 前拒绝 |
| `GET /api/health` | 第六次窗口起点 canary 后返回 200 fresh、Supabase、`lastError=null`，与 full/compact/reload 指向同一 report；13:30 缺槽期间 last-known-good 保持可读但不掩盖四层失败；跨过 30 分钟时仍会如实返回 503 stale |
| 未授权 `GET /api/cron` | 401 |
| 未授权 `POST /api/refresh` | 401 |
| 正确 Cron Bearer | 200，并产生上表第三个 durable run/report |
| 冷实例收敛 | 新部署冷读后 8.5 秒内连续三次读到相同 Supabase report，低于 60 秒门槛 |
| latest read 性能 | 发布门历史压测：完整约 75 KB gzip 响应 P95 `988.0 ms`、P99 `1619.9 ms`，未过门；改用约 32.9 KB compact 后，固定窗口 100 请求、并发 5、错误 0：P50 `377.1 ms`、P95 `671.8 ms`、P99 `961.5 ms`，通过 P95 ≤750 ms、P99 ≤1 s |
| 浏览器 | 1720px 与 390×844 均无横向溢出；compact 水合出完整事件、实时更新与四个时间字段；慢 reload 在 8 秒后释放按钮；11:27 已打开页面在 11:30:31 发布后于 11:31:22 看到新 report，观测上限 51 秒 |
| 回滚演练 | current→previous→bootstrap stale→current 恢复均成功；API 观察收敛 5.769 秒，恢复 4.285 秒 |
| 同槽幂等 | 首个真实 Cron 同槽再次请求返回 202/duplicate，引用相同 run，无第二次发布 |

## 尚未关闭的验收项

- 独立 staging 与真实数据库 20 候选并发 upsert、10 lease 竞争、发布 failpoint 仍是后续 migration 的硬化缺口；当前生产 pgTAP、fencing、同槽 duplicate 与回滚已覆盖主链路。
- 第六次连续 24 小时 burn-in 已从 `2026-07-15T15:45:33.605Z` 起算；逐槽保存四层、来源、TTL、内容与 API 聚合证据，任何硬门失败均立即使本窗口作废并进入诊断。
- 完成 7 天 soak：调度成功率、报告年龄 P95、来源 cadence、source-to-site 延迟与内容质量抽样。

发布门与第六次窗口起算门已通过，当前处于最终 deployment 的连续 24 小时 burn-in；这不等于最终验收完成。当前 Codex 任务保持每小时检查，24 小时通过后才调整为每日检查并进入 7 天 soak。任何内容、性能、权限或调度硬门失败都先停止新增调度或回到 last-known-good，再按 [release-plan.md](release-plan.md) 重验。
