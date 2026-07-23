# Supabase 生产验收记录（2026-07-13）

## 当前结论

状态：**前十一次 24 小时 burn-in 均未通过或被后续部署取代；第十二次候选窗口因 pg_net 网络超时、起点 body 过 TTL 和约 45–51 秒刷新明确失败。随后 compact snapshot/500 候选部署的首五槽又全部触发旧 bloated report 与新受限候选池之间的相对质量门误判，已经同样失败。相对事件门按候选池规模归一化、同时保持绝对 freshness、核心数、来源数与 protected beats 门不变的第二个最小修复现已作为唯一 production deployment 发布；必须从其首个完整自然槽重新建立新 24 小时窗口**。

Supabase 持久化、两次生产迁移、Vercel 读取、受保护刷新和 15 分钟 Supabase Cron 已部署。当前 production deployment `dpl_8GswEGG1CfUn3K2WAdeVPvG7zrpL` 来自 `main@65f9989`，在原有 12 秒总采集预算、maxSources 11、直连并发 11 与 keyless 路径不变的前提下，并发启动 keyless/direct，规范来源失败优先级，使用 Anthropic 官方 sitemap，并对 Supabase 中的大型报告采用向后兼容的 gzip/base64 传输层编码。前十一轮已依次暴露调度丢槽、到期边界、deadline cadence、Supabase 瞬时读失败、半开容量、P95、证据留存、来源 starvation 与报告发布尾延迟问题。24 小时与随后 7 天 soak 完成前，仍不能把本记录解释为“实时更新最终验收完成”。

## 发布标识

| 项 | 值 |
| --- | --- |
| 当前生产 Git commit | `4644e90`（`Fix stale direct-source deadline handling`）；本机 `main` 与 `origin/main` 已 0/0 对齐，production build log 与该 commit 一致 |
| migration | `20260713090000_daily_news_store.sql`、`20260713101500_runtime_hardening.sql`；local/remote list 一致且无 pending dry-run |
| bootstrap report | `ec5f550b-69ee-4324-bac7-143ef5d2e86b`，保留原始 `dataAsOf=2026-07-09T15:39:06.365Z` |
| production deployment | 当前 `dpl_8GswEGG1CfUn3K2WAdeVPvG7zrpL`；`2026-07-22T03:32:32Z` 由 Git integration 创建并 READY，正式 alias 已精确指向它；上一版本为 `dpl_BPP9QWt15YZ5ERshpUu3Zh44S1zd` |
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

修复后回归测试覆盖“10 个旧链接位于 1 个新链接之前”的精确场景；完整 unit 137/137、integration 64/64、build 1711 modules 和 `git diff --check` 通过。真实两来源只读 canary 中，央视/中新网分别为 success 7/5，中新网最新候选为 `2026-07-18T04:38:00Z`；真实 11 来源只读 canary 在 4.181 秒内产生 11/11 outcomes、0 skipped、0 missing、42 个候选。commit `d77fe48` 只触发一个 Git integration production deployment `dpl_HWLN9zVgrm2ndESTSZdkHrRNgTPE`，READY/alias 时间晚于 06:15 自然槽；06:15 报告仍来自旧代码，只作为边界快照。首个可命中新 deployment 的理论槽是 06:30Z，必须由该槽之后的自然 Cron 四层闭环建立第十次 24 小时窗口。

`2026-07-18 06:30Z` 新 deployment 候选基线的公开侧通过：Vercel runtime 日志显示 `/api/cron` HTTP 200，health 在运行完成后推进到 report `f9b56c8e-d59f-490a-a5c4-e0cee75a739b`、`dataAsOf=2026-07-18T06:30:01.595Z`；full/compact/reload 原子一致，候选与首页最新实际活动均为 `06:03:13Z`、年龄约 28.86 分钟，精确标题/摘要/组合/tier 重复均为 0，top/important/watch=8/10/8，核心 18/18 confirmed，`maxPrimaryPublisherShare=0.167`，非法 query 为 400/no-store。但同一 Cron 日志含 `人民网 要闻: collection_deadline` 警告；公开 report 无法证明该源最终由 direct fetch 成功、还是 durable source outcome 为 skipped。当前本机环境没有 Supabase 查询或受保护 refresh 凭据，且未在缺少用户明确授权时拉取生产环境值，所以尚未核对 `cron.job_run_details`、pg_net body 9 键、durable run planned/attempted/skipped/missing 与 runtime latest 四层。06:30 只能称为“公开候选基线”，不能正式启动第十次 24 小时计时。

`2026-07-18 06:45Z` 第二个公开候选槽同样完成发布：health 推进到 report `12c5a74b-537e-40f2-a766-28ca392fbfbd`、`dataAsOf=2026-07-18T06:45:01.756Z`，Vercel 日志中 `/api/cron` 为 HTTP 200；full/compact 同步为 152 stories，full 另含 153 个 legacy items。候选与首页最新实际活动仍为 `06:03:13Z`，06:46 审计年龄约 43.06 分钟；精确标题/摘要/组合/tier 重复 0，核心 18/18 confirmed，`maxPrimaryPublisherShare=0.167`。本槽日志包含 NPR direct abort 与新华 Firecrawl 阶段 `collection_deadline`，但两类阶段日志均可能被同源后续 direct outcome 覆盖，不能据此推断最终 skipped。报告仍只有中新网历史证据，最新为 `2026-07-17T13:27:00Z`，且本槽没有中新网三个受限栏目的特征日志，说明尚未证明该源在新代码下被自然选中。06:45 同样只能作为公开持续性证据，不能替代四层数据库门。

`2026-07-18 07:00Z` 自然槽继续由同一 deployment 响应：Vercel runtime 日志记录 `/api/cron` HTTP 200，公开 health 的 `lastAttemptAt` 与 `lastSuccessAt` 分别推进到 `07:00:03.502607Z` 和 `07:00:21.664844Z`、`lastError=null`，但 latest 仍保留 06:45 report，说明本轮完成后没有发布新报告。07:03 公开门中 health/full/compact/reload 原子一致，152 stories、top/important/watch=8/10/8、核心 18/18 confirmed，精确标题/摘要/组合/tier 重复 0，`maxPrimaryPublisherShare=0.167`；候选与首页实际活动仍为 `06:03:13Z`，年龄约 60.34 分钟，继续低于 120 分钟。日志含 The Verge 的 Firecrawl 阶段 `collection_deadline`，但公开面不能确认最终 durable source outcome，也不能判断 skipped 是否错误推进状态。因此 07:00 仍是公开连续性证据，而不是第十次窗口的正式四层槽。

`2026-07-18 07:15Z` 自然槽发布 report `7e5adc07-d1af-4cd3-a4e8-ddfcc6715052`、`dataAsOf=2026-07-18T07:15:01.755Z`；Vercel runtime 日志中的 `/api/cron` 为 HTTP 200，alias 仍绑定同一 READY production deployment。07:19 公开门中 health/full/compact/reload 原子一致，仍为 152 stories、top/important/watch=8/10/8、核心 18/18 confirmed，精确标题/摘要/组合/tier 重复 0，`maxPrimaryPublisherShare=0.167`；候选与首页实际活动仍为 `06:03:13Z`，年龄约 75.96 分钟，低于 120 分钟。日志没有来源级 `collection_deadline`，但有澎湃新闻 direct HTTP 403、翻译与摘要增强 deadline fallback，且没有命中中新网特征日志。公开面仍不能确认这类来源 outcome、状态推进、Cron/pg_net/durable/snapshot 四层链接，因此 07:15 也不能作为正式第十次窗口基线。

### 第一版排序修复后的再次 stale 与第二版修复

第一版只用标题时间或 URL 日期在截断前做粗排序；同一天 URL 都退化到本地午夜、无日期 URL 都是同一最低优先级，feed 仍保留上游顺序。`08:00Z` 虽发布 report `9af56021-403f-4542-ae51-666ad885c8d7`，155 个 stories 的最新实际活动仍停在 `06:03:13Z`；08:15 自然 Cron 返回 HTTP 500，08:30 health 继续为 503 `stale_candidate_pool`。08:27 检查时内容年龄约 143.9 分钟，full/compact/reload 仍原子同步且非法 query 400/no-store，排除浏览器/CDN；报告 247 个去重 evidence 候选中 06:00Z 后仅 1 个，最新时间由 Guardian 的长寿命聚合事件单点托底。中新网报告证据最新只到 03:12Z，未采用公开页面已有的更新文章。

第二版保持 12 秒预算、来源上限和质量门不变，作以下有界修复：

- HTML 在最新粗日期桶内均匀选择最多 `2 × limitPerSection` 个候选，抓取文章 metadata 后按精确时间重排；文章 HTML 同时复用为摘要上下文；
- feed 先按自带时间排序，同时有界抽样缺日期项，补出文章时间后再次重排；
- 来源 listing、候选 metadata 和 dated-feed 正文共用一个全局 HTTP 闸门，生产默认峰值不超过 11；
- metadata、正文、翻译或摘要在 deadline 到期时统一上抛 `collection_deadline`；没有已采用候选的来源保持 skipped，不把超时伪装成 empty 并推进状态；Keyless 路径采用同一语义。

回归覆盖 10 个同日 HTML 候选、无日期 HTML、逆序 feed、feed 缺日期后二次排序、文章页单次复用、HTML metadata deadline、dated-feed 正文 deadline、Keyless 后处理 deadline，以及 5 个 dated feed 与 6 个 HTML 来源混合时全局 HTTP 峰值不超过 11。最终发布门为 unit 145/145、integration 64/64、build 1711 modules、`git diff --check` 全部通过。真实公开 canary 不写数据库、不使用翻译：两来源在 1.074 秒内 2/2 success、12 个候选、最新 `07:01Z`；11 个中文来源在 7.743 秒内产生 11/11 outcomes、missing 0、52 个候选、最新 `08:10Z`，7 success/4 empty、0 failed/skipped。

commit `2493b40` 只触发一份 Git integration production deployment `dpl_2rrwW4zspHmJCk77T1kBcwzAP8Cy`；构建日志确认 main commit、1711 modules 和 READY，正式 alias 已精确切换。切换后、首个自然 Cron 前的 08:56Z 公开基线仍读取上一报告，因此 health 503 stale 是预期 last-known-good 行为，不可当作新代码失败或通过。首个可命中新 deployment 的自然槽是 09:00Z；公开门通过也仍不能替代需用户授权才能读取的 Cron、pg_net、durable 与 runtime 四层证据。

09:00 自然 Cron 的公开状态在约 3 秒内从 `lastAttemptAt=09:00:02.580Z` 推进到 `lastSuccessAt=09:00:05.667Z`，无新错误但保留旧 report，因此只记为公开 `completed/unchanged` 候选槽；内容仍 stale 且 health 503，没有用空轮洗新鲜度。09:15 自然槽随后发布 report `92e5981b-3a10-4ee7-ba43-efa4121205a9`、`dataAsOf=09:15:01.709Z`，health 恢复 200 fresh/Supabase/`lastError=null`。full、compact、reload 原子一致为 160 stories；09:16 检查时实际最新活动为 `09:00:02Z`、年龄 16.36 分钟，标题/摘要/组合/tier 重复均为 0，top/important/watch=8/9/8，核心 17/17 confirmed，`maxPrimaryPublisherShare=0.176`，261 条证据、23 个来源、10/10 primary beats，invalid query 为 400/no-store。

09:15 runtime 日志仍出现央视、Al Jazeera、中新网、财新、CNBC、BBC 体育与 Ars Technica 等阶段性 `collection_deadline`；其中单条 warning 无法说明同源另一阶段是否成功，也不能证明 skipped 是否未推进状态。该槽发生在生产只读查询授权之前，只作为公开恢复证据，不倒推为第十次 burn-in 的正式四层槽。

### 第十次 24 小时 burn-in（未通过：健康来源 cadence 缺口）

用户已明确授权：可将 Vercel production env 临时拉到权限为 `600` 的随机文件，仅用于只读 Supabase 查询，禁止输出凭据，完成后立即删除。连接烟测确认客户端链路使用 TLS，数据库事务为 `READ ONLY`；所有临时 env、客户端依赖和连接信息均在单次命令结束时删除，文档只保存公开标识与非敏感聚合结果。没有新增审计 RPC、没有修改生产 schema，也没有调用任何写入入口。

第十次窗口固定为 `2026-07-18T09:45:26.886Z` 至 `2026-07-19T09:45:26.886Z`。09:45 自然槽是起点基线；严格理论槽从 10:00 开始，每 15 分钟一个，共 96 个，最后一个为次日 09:45。每槽结束后 1–3 分钟内必须保存 Cron、pg_net 9 键 body 摘要、durable 来源集合、snapshot/runtime 原子链接和 source state 快照；不能再依赖每小时回看，因为 `source_state` 只有当前值，后续槽会覆盖 skipped/失败当时是否推进的证据。

09:45 基线四层与公开门如下：

| 层 | 基线结果 |
| --- | --- |
| Cron | jobid 2、`*/15 * * * *`、active；run 478 在 `09:45:00.230Z` 启动并 `succeeded`，只证明 pg_net 入队 |
| pg_net HTTP | response 480、HTTP 200、JSON、无 timeout/network error；body 精确 9 键，`published`、run/report/count 均与 durable 匹配 |
| durable run | run `6a133972-7f15-42b3-af64-7698d1760c68`，`published`，约 22.760 秒；11 planned、10 attempted、1 skipped、0 missing，集合异常均为空，skipped 未推进 state |
| snapshot/runtime | report `7c9765b9-7551-4b40-be84-4c18d5f90142`；runtime、snapshot、durable run 和 published report 四向链接一致，runtime/lease singleton 均为 1 |
| 来源即时状态 | enabled 49、healthy 47、circuit-open 2、half-open due 0；健康 rolling attempted/succeeded 46/47 与 45/47，eligible backlog 1；下一严格槽必须优先消化该 skipped backlog |
| 公开内容/API | health 200 fresh Supabase、full/合法 compact/reload 原子一致 165 stories；候选与首页最新活动 `09:00:02Z`、检查年龄约 49.76 分钟；标题/摘要/组合/tier 重复 0，top/important/watch=9/9/8，核心 18/18 confirmed，`maxPrimaryPublisherShare=0.167`，invalid query 400/no-store |

09:45 attempted 来源中 9 个是 success/empty，`npr` 为第三次 `source_timeout` 并按 C5 熔断至 `12:45:01.470Z`；此前 `openai` 已熔断至 `11:00:01.677Z`。两者按规则排除当前健康分母。1 个 skipped 来源保持 due，未写 `last_run_id`/`last_attempt_at`；10:00 必须验证它进入 planned/attempted 集合、backlog 清零或按同一规则继续保持 due。

10:00 首个严格槽的调度、HTTP、持久 run 与公开报告本身全部成功，但来源 cadence 硬门失败：

| 层 | 10:00 结果 |
| --- | --- |
| Cron | run 479 在 `10:00:00.202Z` 启动并 `succeeded`；理论/实际严格槽 1/1 |
| pg_net HTTP | response 481、HTTP 200、JSON、无 network error；body 精确 9 键且为 `published` |
| durable run | run `25665294-9cf0-47b4-a362-3dc56eb59725`，约 22.217 秒；11 planned、10 attempted、1 skipped、0 missing，发现/采用 4/4，集合异常为空 |
| snapshot/runtime | report `30b65b11-04f1-4b25-b016-2f755fa8d87f`；durable、report、snapshot、runtime 原子链接一致，失败/重复/running/链接错配均为 0 |
| 来源即时状态 | Anthropic 再次 planned，但未进入 attempted，仍为 skipped 且 state 未推进；enabled 49、healthy 47、circuit-open 2，健康 rolling attempted/succeeded 46/47 与 45/47，eligible backlog 仍只有 Anthropic |
| 窗口性能 | 含 09:45 基线，最大成功间隔 14.989 分钟，run P95/max 22.760 秒，`>30s` 样本 0 |
| 公开内容/API | health 200 fresh Supabase、full/compact/reload 原子一致 168 stories；候选与首页活动 `09:17:00Z`、检查年龄约 45.845 分钟；重复 0，top/important/watch=9/9/8，核心 18/18 confirmed，`maxPrimaryPublisherShare=0.167`，invalid 400/no-store |

Anthropic 最近一次真实 attempt/success 是 `08:15:01.441Z`；10:03 审计时已经过去 108.104 分钟，超过 90 分钟健康 cadence 门。它无失败、无 circuit、`nextDueAt=09:45`，09:45 与 10:00 两个槽均被调度选中却都在 collection deadline 前没有形成 outcome。与第八次窗口采用同一判定标准：`planned` 不能替代 `attempted`，后续成功也不能倒填已经发生的 cadence 缺口，因此第十次窗口在首个严格槽即不可恢复地失败，后续旧 deployment 槽只作诊断，不得拼接。

生产日志证明 Anthropic 的 source worker 确实进入 keyless/direct 链路，问题不是 planner 漏选或并发 worker 未启动。精确单源探针进一步定位到直连 HTML 链路：列表页已有 anchor 内 `<time>` 日期，但旧解析只从清洗后的标题读取日期，导致所有候选被当作无日期文章；列表 self-link 还因尾斜杠差异被重复抓取，陈旧候选则要到翻译与正文处理之后才过滤。在 12 秒整轮预算内，这些无效探测把正确应为 `empty` 的 Anthropic 变成 `skipped`。

最小修复保持 12 秒采集预算、maxSources 11、直连并发 11、读重试、单请求上限、keyless 和质量门不变，只做三点：读取 HTML anchor 内 `<time>` 日期；在正文/翻译前淘汰无日期、未来或超过 72 小时的候选；比较列表 self-link 时忽略尾斜杠。回归测试精确覆盖 self-link、过期 `<time>` 和新鲜 `<time>` 候选；完整 unit 146/146、integration 64/64、build 1711 modules 与 `git diff --check` 均通过。真实 Anthropic 单源不写库 canary 在 10.822 秒内完成为 `empty`；10:00 精确 11-source cohort 在 12.002 秒内产生 11/11 outcomes、0 skipped、0 missing，Anthropic 同样为 `empty`。commit `4644e90` 只触发一份 Git integration production deployment `dpl_BPP9QWt15YZ5ERshpUu3Zh44S1zd`；构建日志确认 main commit、1711 modules、Production/READY，正式 alias 已精确切换。

### 第十一次 24 小时 burn-in（未通过）

第十一次窗口固定为 `2026-07-18T10:30:23.044Z` 至 `2026-07-19T10:30:23.044Z`。10:30 是新 deployment 的首个完整自然 Cron 和起点基线；严格理论槽从 10:45 开始，每 15 分钟一个，共 96 个，最后一个为次日 10:30。每个严格槽必须在下一槽前保存 Cron、pg_net body 9 键摘要、durable 来源集合、snapshot/runtime 原子链接和 source state，不能用后来的可变状态或已过期 HTTP 响应倒推。

10:30 基线四层与来源门如下：

| 层 | 基线结果 |
| --- | --- |
| deployment | `dpl_BPP9QWt15YZ5ERshpUu3Zh44S1zd`、commit `4644e90187fbf1340be080a60212c5f695a48e81`；Production/READY，正式 alias 精确绑定 |
| Cron | jobid 2、`*/15 * * * *`、active；run 481 在 `10:30:00.193Z` 启动并 `succeeded`，精确 1 行 |
| pg_net HTTP | response 483、HTTP 200、JSON、无 timeout/network error；body 精确 9 键，`published`、`ok=true`、`error=null` |
| durable run | run `1fbe0b12-9108-4b06-a92d-41a034bbb192`，`published`，`10:30:04.473Z` 至 `10:30:23.044Z`，18.571 秒；2 planned、2 attempted、0 skipped、0 missing，集合异常与 body count 错配均为空 |
| snapshot/runtime | report `70e97037-b8ad-4cfb-afaa-0a85c9cfaabe`；durable、snapshot 与 runtime latest 原子链接一致，runtime/lease singleton 均为 1，lease 已释放，last error 为空 |
| 来源状态 | enabled 49、healthy 46、circuit-open 3、half-open due 0；健康 rolling attempted/succeeded=46/46，cadence overdue 0，eligible backlog 0，attempted/skipped/missing state mismatch 均为空 |
| 修复自然证明 | Anthropic 为 planned/attempted、非 skipped，`lastRunId` 指向本 run，`lastAttemptAt=lastSuccessAt=10:30:01.646Z`、next due `12:00:01.646Z`、failures 0、无 circuit/error |
| 性能 | 基线 run P95/max 18.571 秒、`>30s` 样本 0；失败/running 0 |

10:33 公开门中 health 为 200 fresh/Supabase，full/合法 compact/reload 原子一致 report `70e97037-b8ad-4cfb-afaa-0a85c9cfaabe`、`dataAsOf=10:30:01.646Z`、171 stories；候选与首页最新实际活动均为 `09:17:00Z`、年龄 76.634 分钟，低于 120 分钟。精确标题/摘要/组合/tier 重复均为 0，top/important/watch=10/9/8，核心 19/19 confirmed，`maxPrimaryPublisherShare=0.158`，25 个来源、10/10 primary beats；非法 query 为 400/no-store。临时 production env、依赖与连接文件在只读事务完成后删除，残留目录为 0；文档没有记录 secret、host 或完整响应。

窗口结束后的只读汇总确认：Cron 为 97/97 succeeded；durable 共 97 行，其中 90 published、3 completed、4 failed，777 planned、766 attempted、11 skipped、0 missing。成功完成最大间隔为 45.146 分钟；durable P95/max 为 27.113/27.677 秒、`>30s=0`，但四次硬失败分别为 22:15/22:30 的 `stale_homepage_selection` 与 04:15/04:30 的 `quality_gate_failed`，所以窗口不可恢复地失败。第十一轮开始前的 pg_net response 483 已超过 TTL，逐槽 9 键 body 不能重新构造；Cron 或 durable 汇总不能替代已过期的 HTTP 证据，这也独立阻止窗口判定通过。

窗口后的活跃 production 进一步出现连续 40–49 秒刷新，最近 24 个样本全部超过 30 秒；最新样本的来源阶段约 16.240 秒、upsert 1.024 秒、最终发布 32.328 秒、总计 49.592 秒。只读函数与本地 report build 均不是主瓶颈；完整公开响应约 2.05 MB，报告主体接近 1.95 MB，未压缩写入导致最终发布占据绝大多数尾延迟。与此同时 Anthropic 再次出现 planned/skipped，说明第十一次修复没有同时守住来源 cadence 与性能门。

最小修复只触及刷新、抓取与 Supabase 存储边界：keyless/direct 在同一 12 秒总预算内并发；HTML 列表卡片直接复用段落/时间，避免正文二次请求；来源 outcome 以 failed/empty/skipped 的保守顺序合并；Anthropic 改读官方 sitemap 的 canonical `loc`/`lastmod` 且不抓正文；已获得 lease 的路径取消一次重复 state read；Supabase report 仅在存储传输层 gzip/base64，读取透明兼容旧 raw payload。当前约 1.95 MB 报告编码后约 691 KB，比例约 0.355，无需 schema migration。

回归门全部通过：unit 149/149、integration 65/65、build 1711 modules、`git diff --check`。三次 Anthropic 不写库 canary 分别在 5.535、6.462、5.156 秒返回 `empty` 且 skipped 0；精确 11-source cohort 在 5.589 秒形成 11/11 outcomes、29 个候选、6 success/5 empty/0 failed/0 skipped。临时 production env、依赖与连接文件均已删除，残留目录 0。上述本地 no-write canary 的翻译入口返回 401，因此只证明 deadline/outcome 语义；Anthropic 在生产自然槽中的真实结果仍必须由新窗口四层证据确认。

commit `65f9989` 只触发一份 Git integration production deployment `dpl_8GswEGG1CfUn3K2WAdeVPvG7zrpL`；构建为 1711 modules、Production/READY，正式 alias 已精确切换，`main...origin/main=0/0`。切换后的 11:34 公开门为 health/full/compact/reload 200、invalid 400，storage Supabase、health error 空；四种合法读取原子指向 report `fa82cf56-9e4f-4d6a-b9fc-0824a86c9459`，full/compact 均为 487 stories。候选/首页活动年龄为 37.108/28.225 分钟，标题/摘要/组合/tier 重复均为 0，top/important/watch=10/17/8，核心 27/27 confirmed，`maxPrimaryPublisherShare=0.111`，25 个来源、10/10 primary beats；缓存契约保持 full/compact public max-age=0、reload/invalid no-store。

### 第十二次 24 小时 burn-in（失败；等待修复部署重置）

`2026-07-22T03:45Z` 至 `11:45Z` 共 33 个理论槽均有唯一 Cron succeeded 和唯一 durable published，缺槽、重复、failed、running 均为 0；durable planned/attempted 集合逐槽一致，skipped/missing 均为 0，snapshot、runtime、latest 原子指向同一 report，singleton 为 1、lease 已释放。最新 `11:45Z` run 为 `5f38ab34-fe11-460f-9c98-9a598b19e21d`，report 为 `40ddb792-231c-42af-b05e-4806cd4c574f`，11 planned/11 attempted/0 skipped/0 missing，duration 51.375 秒。

该候选窗口存在三个不可恢复硬失败。第一，`03:45Z` 起点的 pg_net body 在审计前已超过 TTL，不能用 Cron/durable 汇总补造起点；当前只保留最近 24 条，其中 23 条 HTTP 200 且 body 精确 9 键，`06:00Z` response 849 为网络 timeout/error。第二，33 个 durable 样本均约 45–51 秒，持续违反 `run<=30s`。第三，缺失的起点 HTTP 证据与中途网络错误都不能靠后续成功样本拼接，因此第十二次没有形成可验收的 24 小时窗口。

来源与公开内容门本身保持健康：enabled 49、healthy 46、circuit-open 3、half-open due 0，健康来源 rolling attempted/succeeded 为 46/46，cadence overdue 与 backlog 均为 0；Anthropic 在其自然槽为 planned/attempted、非 skipped，最近 attempt/success 为 `11:00:01.547Z`，failures 0、无 circuit/error。公开 health/full/compact/reload 为 200、invalid 为 400，四视图原子指向 report `40ddb792-231c-42af-b05e-4806cd4c574f`；候选/首页活动年龄 49.731 分钟，四类重复为 0，top/important/watch=10/17/8，核心 27/27 confirmed，publisher share 0.111，26 个来源、10/10 primary beats，缓存契约正确。

进一步诊断发现当前 full report raw 约 2.50 MB、gzip-base64 约 879 KB；compact raw 约 1.37 MB、gzip-base64 约 445 KB。生产数据不写库 canary 将读取候选限制为按实际 published/discovered 时间倒序的最新 500 条后，保留 340 stories、top/important/watch=10/14/8、核心 24/24 confirmed、publisher share 0.125、24 个来源、10/10 beats，候选/首页活动年龄 46.374 分钟；compact snapshot 约 839 KB raw、270 KB gzip-base64。最小修复因此只做三件事：Supabase storage view 2 存 compact snapshot 并透明兼容旧 full-gzip；刷新只读取最新 500 候选；unchanged 判定优先使用 RPC 返回的持久化 `content_hash`，避免 compact hydrate 重建 legacy items 后误判内容变化。unit 150/150、integration 66/66、build 1711 modules、`git diff --check` 全部通过；临时 production env、依赖与连接目录残留为 0。

commit `dc9128d` 只触发一份 Git integration deployment `dpl_C2SrFbFSKWeYczjGY6te6v5G8gyW`，08:51:51 CST 创建后为 Production/READY，正式 alias 精确切换。部署后的 `01:00Z` 至 `02:00Z` 五个自然槽虽均有唯一 Cron succeeded、planned/attempted outcome 完整、source cadence/backlog 健康、Anthropic 在 `02:00Z` planned/attempted 且非 skipped，但 pg_net 五条均为 HTTP 422，durable 五条均 `quality_gate_failed`；duration 为 24.701–35.098 秒，其中 4 条超过 30 秒。runtime 保留旧 report `20597e71-2887-40c5-b18c-e488852ae547`、last error 为 `quality_gate_failed`，health 503；full/compact/reload 虽仍原子一致且四类重复为 0、核心 25/25 confirmed、publisher share 0.12、27 来源、10/10 beats，但候选/首页实际活动年龄已经约 331/329 分钟，发布门失败。

失败点不是 500 上限本身，而是相对质量门仍用旧 bloated report 的 581 events 直接要求新 report 至少保留 60%，没有按候选池从约 828 收敛到 500 的输入规模归一化。修复保持 60% 事件密度门不变，只将其按 `min(1,currentCandidateCount/previousCandidateCount)` 缩放；候选量未减少时行为完全不变，核心数、来源数、protected beats 与绝对 freshness/quality 门均未放宽。72 小时精确 production no-write canary 为 500 candidates、332 stories、top/important/watch=9/15/8、23 来源、10/10 beats，最新首页活动年龄 60.776 分钟，relative gate=true，compact raw/encoded 约 830/269 KB，read/build 本地约 0.786/3.625 秒。新增“同候选量骤降仍拒绝”和“受控候选池高密度收缩允许”两条回归后，unit 152/152、integration 66/66、build 1711、`git diff --check` 全部通过；下一份 deployment 将再次重置所有窗口。

commit `e151c1d` 只触发一份 Git integration deployment `dpl_FcDWWK6NWTLNHhCCNpzkhCwhAZQG`；创建于 `2026-07-23T03:37:28Z`，Production/READY，构建 1711 modules，正式 alias 已精确切换，`main...origin/main=0/0`。首个可建立基线的完整自然槽为 `03:45Z`（北京时间 11:45）；11:47 必须核对 Cron、pg_net 精确 9 键、durable 集合与 `<=30s`、snapshot/runtime 原子性、source cadence/backlog 和公开内容门。首槽仍会读取旧 full snapshot，但必须成功发布 compact；若首槽自身超过 30 秒则不能作为基线，后续成功槽也不得与它拼接。

`03:45Z` 至 `05:00Z` 六个理论槽均有唯一 Cron succeeded、唯一 pg_net HTTP 200 且 body 精确 9 键、唯一 durable published，并且 snapshot/runtime/latest 原子链接、storage view 2 compact gzip-base64、singleton 1、lease released；缺槽、重复、running、failed、network error 和集合 missing 均为 0。公开 health/full/compact/reload 为 200、invalid 为 400，最新 report `5514e7b4-fda5-4abd-8014-59864751cf7b` 共 327 stories，候选/首页活动年龄约 79.231/33.231 分钟，四类重复为 0，top/important/watch=10/12/8，核心 22/22 confirmed，publisher share 0.136，24 来源、10/10 beats。

该部署仍未形成基线。六个 durable duration 依次为 33.199、25.620、33.997、33.487、33.985、33.953 秒，P95/max 33.997 秒且 5/6 超过 30 秒；`05:00Z` run `6afe892d-3f51-4b97-b13f-eedc12b68125` 的 Anthropic 虽在 planned 集合却未进入 attempted，形成 9/8/1/0 planned/attempted/skipped/missing，健康 cadence overdue 与 eligible backlog 各为 1。其最近 attempt/success 仍停在 `03:30:01.325Z`，证明“已成功取得 listing/feed 但后续 metadata/context 因总窗口截止”仍被错误记为 skipped。历史成功槽不得与本部署后续槽拼接。

最小性能修复不改 12 秒 collection 总预算、maxSources 11、直连并发 11 或 keyless 路径：lease acquire 与首次 state read 并行；仅当 source registry 的 ID/enabled/interval 真正漂移时才执行 49-source `syncSources`，否则复用同一 state；若 listing/feed 已成功取回，则后续 metadata/context 窗口耗尽记为 attempted-empty 而不是 skipped，完全未启动或未完成源请求仍保持 skipped。聚焦测试 75/75、unit 152/152、integration 66/66、build 1711 modules 与 `git diff --check` 全部通过；必须发布新 deployment 并从其首个满足四层、cadence 与 `<=30s` 的自然槽重新起算。

commit `19b7de0` 只触发一份 Git integration deployment `dpl_9hRhJ572c2bFedxpnoARm1oLuNAG`；创建于 `2026-07-23T05:19:39Z`，Production/READY，正式 alias 已精确切换。此前所有窗口再次作废；首个完整自然槽为 `05:30Z`，只有该槽同时满足 Cron、pg_net、durable `<=30s`、snapshot/runtime 原子性、source cadence/backlog 与公开内容门时，才以其真实 started/finished/finished_at 建立新的 24 小时基线。

`05:30Z` 首槽完成除性能外的全部硬门：Cron run 941 唯一 succeeded；pg_net response 943 为 HTTP 200、body 精确 9 键且无 network error；durable run `c21cdaad-e596-4757-945c-5920184ca8de` published report `9f78e504-f42e-419b-9428-8177678c407c`，planned/attempted/skipped/missing=4/4/0/0、集合和 body counts 一致；storage view 2 gzip-base64、snapshot/runtime/latest 原子一致、singleton 1、lease released。49 个 enabled 来源为 healthy 46/open 3/half-open due 0，健康 rolling attempted/succeeded=46/46，cadence overdue 与 eligible backlog 均为 0。Anthropic 本槽未到期，最近一次在 `05:15:01.441Z` 成功 attempted，next due 为 `06:45:01.441Z`，failures 0、无 circuit/error。

该 run 从 `05:30:02.617Z` 到 `05:30:33.802Z`，duration 31.185 秒，超过 30 秒硬门 1.185 秒，因此 `05:30Z` 不能建立基线。公开 health/full/compact/reload=200、invalid=400，四视图原子指向同一 report，共 328 stories；候选/首页活动年龄 36.390 分钟，标题/摘要/组合/tier 重复均为 0，top/important/watch=10/13/8，核心 23/23 confirmed，publisher share 0.13，24 来源、10/10 beats。Vercel 日志没有异常堆栈，只有 NPR keyless 路径在总窗口边界记录 `collection_deadline`，而 durable outcome 仍正确记为 attempted。下一候选自然槽改为 `05:45Z`；失败槽不得与其拼接。

截至 `08:30Z` 的累计只读审计进一步确认该 deployment 不可恢复：`05:45Z` 至 `08:30Z` 共 12 个 Cron 均唯一 succeeded、无重复，但 `05:45Z` response 944 为 HTTP 500 且没有 durable run；`06:00Z` 至 `08:15Z` 十个已结束 durable 中，只有 `07:00Z` 的 24.243 秒有源槽和 `07:15Z` 的 1.354 秒 no-source 槽低于 30 秒，其余八个为 31.543–33.679 秒。其余 pg_net 均 HTTP 200/body 精确 9 键、集合一致、0 skipped/missing、snapshot 原子；Anthropic 在 `06:45Z` 与 `08:15Z` 两次均 planned+attempted、非 skipped，证明 outcome 修复稳定，但性能和 05:45 缺 durable 已使窗口永久失败。

公开内容在最终审计仍健康：health/full/compact/reload=200、invalid=400，最新完整槽 report `42da67ff-589e-40e1-a211-7c096386cfd2` 共 336 stories，候选/首页活动年龄约 20.182/48.216 分钟，四类重复为 0，top/important/watch=10/14/8，核心 24/24 confirmed，publisher share 0.125，24 来源、10/10 beats。新的最小性能修复不改变 12 秒采集预算、maxSources 11、直连并发 11、keyless、排序或质量门：读取最新 500 候选与采集并行；按持久层相同的 `(sourceId, canonicalUrl)`、`coalesce(publishedAt)` 与最早 discovered 时间在内存合并本轮候选；source-state 与 candidate 写 RPC 并行，并让同步 report build 与写入重叠，但所有失败、完成和发布动作仍等待两次写成功。unit 154/154、integration 68/68、build 1711 modules 与 `git diff --check` 全部通过；下一 deployment 再次重置所有窗口。

commit `19b3f3c` 只触发一份 Git integration production deployment `dpl_EACb33TJcxyjHU19RMve6nLf8zJ2`；创建于 `2026-07-23T08:47:28Z`，Production/READY，正式 alias 精确切换。首个完整自然槽 `09:00Z` 的 Cron run 955 唯一 succeeded，pg_net response 957 为 HTTP 200、body 精确 9 键且无 network error。durable run `8b6456e1-f1bf-4de2-9369-25d5270ddbc8` published report `8263147b-d18a-4147-a2d1-d6c0ea38c389`，planned/attempted/skipped/missing=11/11/0/0、集合与 body counts 一致；snapshot/runtime/latest 原子、storage view 2 gzip-base64、singleton 1、lease released。enabled 49、healthy 46/open 3，健康 rolling attempted/succeeded=46/46，cadence overdue 与 eligible backlog 均为 0；Anthropic 本槽未到期。

该首槽从 durable started 到 finished 为 30.547 秒，仍超过 30 秒硬门 0.547 秒，不能建立基线。公开 health/full/compact/reload=200、invalid=400，四视图原子指向同一 report，共 339 stories；候选/首页活动年龄约 40.195 分钟，四类重复为 0，top/important/watch=10/13/8，核心 23/23 confirmed，publisher share 0.13，24 来源、10/10 beats。与旧 deployment 可比的 `06:00Z` 31.543 秒有源槽相比，应用侧并行优化约回收 0.996 秒，但不足以满足硬门；该 deployment 的任何后续成功槽也不能与 09:00 拼接。

下一最小修复把 source outcome、candidate upsert 与 report publish 复用现有 fencing/校验 RPC，并在同一数据库事务和单次 HTTPS 往返中提交；失败、unchanged 与无发布路径仍保留现有分步语义。新增原子路径与 RPC payload 回归后，unit 156/156、integration 70/70、build 1711 modules 与 `git diff --check` 全部通过。`npx supabase db push --dry-run` 因仓库未 link 而在执行前停止；当前 Supabase CLI 账户只读枚举可见项目数为 0，不能安全 link 或应用迁移。受 production env 只允许只读查询的授权边界约束，没有借环境连接执行 DDL，也没有部署会调用尚不存在 RPC 的应用代码；待获得正确 Supabase project link/迁移权限后，必须先 dry-run、应用迁移、再发布并重置窗口。

### 第十三次 24 小时 burn-in（失败：即时 state 证据缺失）

原子迁移权限仍不可用，但当前 application-only deployment 在不改代码的情况下从 `09:30Z` 起出现稳定的低于 30 秒样本。`09:30Z` 至 `11:30Z` 共 9 个自然槽全部 Cron/pg_net/durable 闭环，duration 依次为 29.784、29.290、21.453、1.844、29.937、28.991、29.531、29.135、29.678 秒，max 为 29.937 秒；pg_net 均 HTTP 200、body 精确 9 键、network error 0，durable failed/running/skipped/missing 与集合错配均为 0。Anthropic 在 `09:45Z` 与 `11:15Z` 两个自然槽均 planned/attempted、非 skipped。由于这些槽没有在各自结束后 1–3 分钟保存即时 source state，只作恢复趋势诊断，不能回溯拼成正式窗口。

`11:45Z` 是新的正式基线。Cron run 966 在 `11:45:00.230Z` 启动并唯一 succeeded；pg_net response 968 为 HTTP 200、body 精确 9 键、无 network error。durable run `2ab18aa4-78ce-4118-a350-337bedce74fc` 从 `11:45:02.051Z` 到 `11:45:04.149Z`，2.098 秒 completed/unchanged，0 planned/attempted/skipped/missing；body 保留上一 published report `086def33-53ba-4537-94f9-1fac380c4f74`，runtime latest 同样保持该 report，lease 释放、singleton 1、last error 空。无源 completed 槽没有新 snapshot/published_report_id 是预期语义，不算原子链接失败。enabled 49、healthy 46/open 3、rolling attempted/succeeded 46/46、cadence overdue 0、eligible backlog 0；Anthropic 最近一次 attempt/success 为 `11:15:01.624Z`，next due `12:45:01.624Z`，failures 0、无 circuit/error。

11:56 公开门为 health/full/compact/reload 200、invalid 400，四视图原子指向 `086def33-53ba-4537-94f9-1fac380c4f74`、335 stories；候选/首页实际活动年龄 56.198 分钟，四类重复为 0，top/important/watch=9/12/8，核心 21/21 confirmed，publisher share 0.143，24 来源、10/10 beats，缓存契约正确。审计因 automation/执行时钟推进在槽后约 11 分钟完成，但发生在下一自然槽前，source state 尚未被覆盖；文档保留实际审计时间，不伪称 1–3 分钟。

窗口以 11:45 Cron started/finished 与 durable finished_at 固定边界；严格理论槽从 `12:00Z` 开始，每 15 分钟一槽，共 96 槽，最后为次日 `11:45Z`。首个严格槽 `12:00Z` 的 Cron run 967 唯一 succeeded；response 969 HTTP 200、精确 9 键、无 network error。durable run `e0cf11de-2fd7-43ba-9566-dea59ee49a1d` 从 `12:00:02.397Z` 到 `12:00:32.221Z`，29.824 秒 published report `26a272c9-5444-4ffe-96c0-1e967cabc359`；11 planned/11 attempted/0 skipped/0 missing，发现/采用 20/20，集合与 body counts 一致，storage view 2 gzip-base64、snapshot/runtime/latest 原子、lease released。来源状态仍为 enabled 49、healthy 46/open 3、rolling attempted/succeeded 46/46、overdue/backlog 0；公开四视图原子一致 338 stories，活动年龄 35.833 分钟，重复 0，top/important/watch=10/11/8，核心 21/21 confirmed，publisher share 0.143，24 来源、10/10 beats。

截至 `12:13:26.957Z`，严格理论/实际槽为 1/1，失败、缺槽、重复、running、skipped、missing、network error、链接错配均为 0；baseline+strict duration P95/max 为 29.824 秒，最大成功完成间隔约 15.468 分钟。12:00 审计同样因执行时钟推进在槽后约 13 分钟完成，但仍早于 12:15，source state 未被后续槽覆盖。后续 heartbeat 必须尽量恢复到槽后 1–3 分钟；任何槽若已被下一槽覆盖且没有即时 state 证据，不得补造或拼接。

主执行时钟随后从 `12:13Z` 直接推进到 `12:36Z`；12:15 的 source state 已被 12:30 覆盖，且没有独立即时快照，因此第十三次窗口在严格槽 2 因证据链不可恢复而失败。只读诊断仍确认生产两槽本身通过：12:15 run `281555f4-1d18-4191-a275-615be14bdfd8` 在 29.990 秒发布 report `7b5362eb-0555-4eee-aec4-4810329d7f44`，12:30 run `8a2d50d7-b266-40ef-bdb3-d8e5c0a0ba6c` 在 28.987 秒发布 report `6ae94ca7-95d5-4b0b-89b9-21a2380b91c2`；两槽均 Cron/HTTP 200 精确 9 键/durable/snapshot-runtime 闭环，11/11 attempted、0 skipped/missing、无 network error。12:30 即时状态为 enabled 49、healthy 46/open 3、rolling attempted/succeeded 46/46、overdue/backlog 0；公开四视图原子一致 337 stories，活动年龄 20.015 分钟，重复 0，核心 22/22 confirmed，publisher share 0.136，24 来源、10/10 beats。

12:45 再次满足生产基线门：Cron run 970 succeeded、response 972 HTTP 200 精确 9 键、durable run `b9444479-c552-49e8-924f-8de9547bd7e0` 在 29.681 秒发布 report `4471edbb-ac4b-4e47-b5ef-6c3496e02d6d`；11 planned/11 attempted/0 skipped/0 missing，Anthropic 实际 attempted/succeeded，next due `14:15:01.576Z`、failures 0、无 circuit/error，source cadence/backlog 与公开门全部通过。为 13:00 首个严格槽预准备的 bounded watcher 到点执行，但公开 API smoke 返回 Node fetch timeout code 23，脚本按 fail-closed 没有输出已读取的数据库部分；主执行时钟再推进到 13:25，13:00 state 已被 13:15 覆盖。故 12:45 候选也不能形成可验收窗口；不能只因生产趋势持续健康而跳过缺失的即时证据。

### 第十四次 24 小时 burn-in（失败：首个严格槽性能与 cadence 硬门）

`2026-07-23T15:15Z` 的 completed/unchanged 自然槽在 `15:18:19Z`、下一槽开始前保存了数据库五层、即时 source state 与公开 API 证据，因此建立新的正式基线。当前唯一 production deployment 仍为 `dpl_EACb33TJcxyjHU19RMve6nLf8zJ2`，alias 精确命中该 deployment；没有代码提交、迁移或新部署。

基线 Cron run 980 在 `15:15:00.219Z` 启动、`15:15:00.278Z` 结束并唯一 succeeded；pg_net response 982 为 HTTP 200、body 精确 9 键、无 network error。durable run `020fd095-83d7-4da9-9748-2a53d9fad822` 从 `15:15:02.828Z` 到 `15:15:04.756Z`，1.928 秒 completed/unchanged，planned/attempted/skipped/missing 均为 0。response body、runtime latest 与 health/full/compact/reload 均保留上一 published report `cfc50213-be51-43aa-92e7-3775229aa4f5`；该 report 的 snapshot 在 15:00 published run 中已链接，completed 槽不新建 snapshot/published_report_id 是预期语义。runtime/lease singleton 均为 1，lease released，last error 为空。

即时来源状态为 enabled 49、healthy 46、circuit-open 3、half-open due 0；健康 rolling attempted/succeeded=46/46，cadence overdue 与 eligible backlog 均为 0，skipped 未推进状态。Anthropic 本槽未到期，最近一次 attempt/success 为 `14:30:01.590Z`，next due `16:00:01.590Z`，failures 0、无 circuit/error；16:00 到期槽必须特别核对其真实 planned/attempted outcome。

15:18 公开门为 health/full/compact/reload=200、invalid=400，缓存契约分别为 public max-age 0/public max-age 0/no-store/no-store；四视图原子指向同一 report，共 337 stories。候选与首页最新实际活动均为 `14:28:47Z`，审计时年龄 49.542 分钟；标题/摘要/组合/tier 重复均为 0，top/important/watch=10/12/8，核心 22/22 confirmed，publisher share 0.136，24 来源、10/10 beats，storage Supabase、health error 为空。

窗口以 durable finished_at `2026-07-23T15:15:04.756Z` 为基线边界；严格理论槽从 `15:30Z` 开始，每 15 分钟一槽，共 96 槽，最后为次日 `15:15Z`。15:00 槽本身 29.980 秒且生产五层健康，但审计开始时 15:15 已结束，不能用其被覆盖后的即时 source state 建立或拼接窗口。Supabase CLI 本次项目枚举仍不可用，原子 RPC 备用修复保持未迁移、未提交、未部署；当前 production 性能通过，继续只读 burn-in。

首个严格槽 `15:30Z` 在 `15:31:16.977Z` 即时审计。Cron run 981 唯一 succeeded；pg_net response 983 为 HTTP 200、body 精确 9 键、无 network error。durable run `30961a18-a9bb-4e39-be0c-4ccee15ce06d` published report `89bebffa-eab8-4ceb-b602-18c107609715`，11 planned/11 attempted/0 skipped/0 missing，集合与 body counts 一致，发现/采用 13/13；snapshot/runtime/latest 原子、storage view 2 gzip-base64、singleton 1、lease released。

该 run 从 `15:30:02.584Z` 到 `15:30:33.206Z`，duration 30.622 秒，超过 30 秒硬门 0.622 秒。即时来源状态另有 `x-karpathy` overdue/backlog 1，健康 rolling attempted/succeeded 为 45/45；它上次 attempt 为 `14:00:01.033Z`、next due 为 `15:30:01.033Z`，在本槽 source selection 前已到期，却因 11 个更早/同批 due 来源占满 `maxSources=11` 留在队尾。本槽 selected 11/11 全部真实 attempted、没有 skipped 或错误推进，但未清空 eligible cohort。公开 health/full/compact/reload=200、invalid=400，四视图原子一致 338 stories，候选/首页活动年龄 62.500 分钟，四类重复 0，top/important/watch=9/12/8，核心 21/21 confirmed，publisher share 0.143，24 来源、10/10 beats。

因此第十四次窗口在严格槽 1 立即失败；15:15 基线及 15:30 失败槽都不得与后续候选拼接。现有未部署的原子 commit RPC 正针对成功发布路径的三次数据库往返，但 Supabase CLI 项目枚举仍不可用，不能 dry-run/apply migration，也不能部署会调用不存在 RPC 的应用代码。cadence 侧还需在不提高 `maxSources=11` 的前提下确定性错开同批第 12 个来源；只部署错峰不能消除当前性能硬失败。后续自然槽只作只读诊断；取得正确 project link/迁移权限前，不做 DDL/DML、提交或部署。

## 历史内容与首页证据（第九次窗口截至 08:21Z）

- 当前 report `a44365a3-86f2-4e3c-ba7a-d16e8be46240` 共 212 个事件、24 个来源；top/important/watch 为 10/15/8，核心 25 条全部为 confirmed，`dataAsOf=2026-07-16T08:15:01.654Z`。
- 候选池与首页最新活动均为 `2026-07-16T07:22:51Z`，08:21 审计时约 58.17 分钟，低于 120 分钟发布门；report 年龄约 5.99 分钟。
- “实时更新”继续按 evidence/published/updated 的最大活动时间排序；developing 只进入持续关注，不伪装成核心已确认新闻。
- 标题、摘要、标题摘要组合的精确重复均为 0；三个首页层无交叉引用或资格违规。
- 全量 trust 为 high 29、medium 183、low 0，`shouldShow=false` 项 0；全量 212 条均有证据。
- 核心媒体最高占比为 3/25=`0.12`，与报告声明一致，满足核心至少 15 条时不高于 0.2；共享每媒体最多 3 条的绝对上限也满足。全量 321 条证据覆盖 24 个来源，10/10 分类均有覆盖。

## 生产 API smoke（当前公开侧与历史运维证据）

| 检查 | 结果 |
| --- | --- |
| 首页 | 200；正式 alias 已指向新 deployment |
| 完整 `GET /api/news` | 10:30 report 为 200；含 171 个 `stories` 和完整分区对象，保持 V2/legacy 兼容 |
| compact `view=web&window` | 10:30 report 为 200；171 个 stories、10/9/8 个分区 ID、171 条 ranking metadata，不含 legacy items；30 秒窗口使用共享缓存 |
| compact `view=web&reload=1` | 200；与 full/compact 的 report ID、dataAsOf、story count 同步；不含 items，浏览器 `Cache-Control: no-store` |
| 非法 cache query | 400 + `no-store`；非规范前导零 window 在读取 durable storage 前拒绝 |
| `GET /api/health` | 10:30 基线返回 200 fresh、Supabase、`lastError=null`；full/compact/reload 原子指向同一 report `70e97037-b8ad-4cfb-afaa-0a85c9cfaabe`；发布前旧内容阶段如实返回 503 stale |
| 未授权 `GET /api/cron` | 401 |
| 未授权 `POST /api/refresh` | 401 |
| 正确 Cron Bearer | 当前 deployment 的 10:30 首个完整自然槽已完成 Cron/pg_net/durable/snapshot-runtime 四层闭环，并发布当前 report |
| 冷实例收敛 | 新部署冷读后 8.5 秒内连续三次读到相同 Supabase report，低于 60 秒门槛 |
| latest read 性能 | 发布门历史压测：完整约 75 KB gzip 响应 P95 `988.0 ms`、P99 `1619.9 ms`，未过门；改用约 32.9 KB compact 后，固定窗口 100 请求、并发 5、错误 0：P50 `377.1 ms`、P95 `671.8 ms`、P99 `961.5 ms`，通过 P95 ≤750 ms、P99 ≤1 s |
| 浏览器 | 1720px 与 390×844 均无横向溢出；compact 水合出完整事件、实时更新与四个时间字段；慢 reload 在 8 秒后释放按钮；11:27 已打开页面在 11:30:31 发布后于 11:31:22 看到新 report，观测上限 51 秒 |
| 回滚演练 | current→previous→bootstrap stale→current 恢复均成功；API 观察收敛 5.769 秒，恢复 4.285 秒 |
| 同槽幂等 | 首个真实 Cron 同槽再次请求返回 202/duplicate，引用相同 run，无第二次发布 |

## 尚未关闭的验收项

- 独立 staging 与真实数据库 20 候选并发 upsert、10 lease 竞争、发布 failpoint 仍是后续 migration 的硬化缺口；当前生产 pgTAP、fencing、同槽 duplicate 与回滚已覆盖主链路。
- 第八次窗口已在 00:15 因健康来源 cadence 缺口判定失败；第九次窗口只有前 30/96 个严格槽保存了完整四层证据，剩余 66 个槽的 pg_net 证据已过期且未独立落盘，因此不能判通过。
- 第十次窗口因 Anthropic cadence 失败；第十一次窗口因 4 个 durable hard failure 与 45.146 分钟最大成功间隔失败；第十二次候选窗口因 pg_net/证据 TTL/性能失败；后续 deployments 又分别因质量门、持续 `>30s`、缺 durable 与 09:00/09:15 的 `>30s` 失败。第十三次与 12:45 后续候选因执行时钟推进/公开 smoke timeout 未能逐槽保存即时 state，同样不可拼接。第十四次窗口在首个严格槽因 duration 30.622 秒及 eligible backlog 1 失败；原子提交迁移仍须取得正确 Supabase project link/迁移权限，只作为再次生产性能失败时的备用修复。
- 完成 7 天 soak：调度成功率、报告年龄 P95、来源 cadence、source-to-site 延迟与内容质量抽样。

历史失败窗口均不能拼接。当前唯一 production deployment 为 `dpl_EACb33TJcxyjHU19RMve6nLf8zJ2`；当前没有 active 24 小时窗口。下一 heartbeat 继续把“预准备临时 client 并由 bounded session 在槽后立即查询”放在首位，且公开 smoke 必须 fail-soft，不能吞掉已经 ROLLBACK 的数据库证据；后续槽只作新候选或根因诊断，不得与 15:15/15:30 拼接。原子提交修复尚未迁移或部署；生产已再次违反性能门，但仍须先取得正确 Supabase project link/迁移权限才能 dry-run、迁移、发布并重新起算。只有完整 24 小时窗口通过后才调整为每日检查并进入 7 天 soak。任何内容、性能、权限或调度硬门失败都先停止新增调度或回到 last-known-good，再按 [release-plan.md](release-plan.md) 重验。
