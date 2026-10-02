# P5 本地有界试运行

状态：进行中。记录日期为 2026-10-03（Asia/Shanghai）。本次仅使用独立本地库，不合并代码 PR、不切换生产、不购买采集服务、不发送外部通知。批准依据见[重构计划](planning/aihot-v2-refactor-plan.md)。

## 固定配置

| 项目 | 本次值 |
| --- | --- |
| 试运行 ID | `p5-2026-10-03` |
| 数据库 | 本机 PostgreSQL 17.11，`dailynews_p5_trial`，端口 55432 |
| 来源 | 14 个已核验栏目；[固定清单](../reference/trials/p5-2026-10-03.json)与[选择器、原文、日期证据](../reference/trials/p5-2026-10-03-sources.json) |
| 样本配额 | 正常新增最多 100 条；回灌最多 20 条，分开持久化计量 |
| 采集与模型并发 | 采集 4；全部聊天模型共享 2 个数据库占位 |
| 调用限额 | 全部聊天模型合计 20/min、200/hour、1000/day；每个服务还须有显式预算 |
| 模型 | 全部文本能力使用 `default`，请求 `deepseek-flash`，官方 `https://api.deepseek.com`，关闭思考和视觉模式 |
| 其他付费服务 | 预算为 0；未配置 embedding；Firecrawl、X、Jina、SocialData 未启用 |
| 本地公开预览 | Web 3310、API 3311，仅 loopback；API 进程关闭模型调用 |

`GET /models` 于 2026-10-02 20:16:45 UTC 返回 `deepseek-flash` 的显示名称为 `DeepSeek-V4.1-Flash`；实际聊天回执也单独记录 `response.model`。这是供应商公开的模型标识，不能据此证明未公开的内部权重构建版本。规则签名仍使用实际请求的模型名、服务、端点及参数；供应商在不改别名时切换内部版本不会自动触发重判。

价格核对自 [DeepSeek 官方价格页](https://api-docs.deepseek.com/quick_start/pricing/)：本次非高峰每百万 token 为缓存命中输入 $0.003、未命中输入 $0.15、输出 $0.60。固定价格窗为 `2026-10-02T20:00:00.000Z` 至 `2026-10-03T23:59:59.000Z`，窗口外停止试运行处理。费用是按响应 token 分类及该价格快照计算的 USD **估算**；现有账户余额以 CNY 返回，两者不直接相减。账户绝对余额和凭据不进入仓库。

## 运行边界

0046 保存请求模型与响应模型、input/output/cache tokens、价格快照及高精度估算；缺预算直接拒绝。0047 保存单库唯一 cohort、逐源首次真实采集时间和入组资料；0048 禁止修改已固定的配额、配置 hash、来源基线和入组行。配置变化、错误数据库、缺少试运行环境或关闭后的重启都不能变成不受限 worker。

每个来源第一次实际采集建立时间基线。首次导入保留原 `backfill`；之后只有原文发布时间晚于该基线的资料能占正常新增配额。BBC、CNBC 的 feed 日期可能是更新时间，因此本次以原文 `datePublished` 为准；量子位、新华网、NBA 使用核验后的日期规则。未知日期不伪装为正常新增。网页文章全文只供内部分析，公开全文与转载权限均保持关闭。

worker 只处理已入组 ID，五分钟补队也只读取这些 ID。不会自动轮询新来源、扩样本、批量重分类、翻译全文或发送通知。`freeze` 停止采集和新增入组，既有任务仍可完成；`close` 停止整组后续处理，均不能重新开放。冻结后产生的既有任务费用仍纳入报告，不能用冻结时刻截断账本。

付费预留与关闭操作按同一试运行行锁串行；已预留请求可保存其实际结果。报表统计该隔离库自试运行创建后的全部 live 尝试，关闭时间之后的异常尝试另列诊断，不能因为越界而在费用中隐藏。实际并发占位和分钟/小时/日滚动峰值由回执时间计算。日报、周报、月报在本次模式下拒绝未到编辑截止的窗口。

## 命令与证据

先在新建隔离库执行迁移、seed，再按上述来源复核文件应用明确配置，设置实际所用 `llm`、`deepseek`、`llm-global` 预算。其余来源继续停用。私有 env 文件设为 0600，准备好官方模型、有效价格窗和 `DAILYNEWS_TRIAL_DB_NAME` 后运行：

```bash
node --env-file=.data/p5.env scripts/bounded-trial.ts init --manifest reference/trials/p5-2026-10-03.json
# 将 init 返回的 ID、settingsHash 与 mode=bounded 写入同一私有 env；不用新 ID 重置样本。
node --env-file=.data/p5.env scripts/bounded-trial.ts collect --id p5-2026-10-03
node --env-file=.data/p5.env apps/worker/src/main.ts
node --env-file=.data/p5.env scripts/bounded-trial.ts status --id p5-2026-10-03
# 仅在该上海日期的 08:00 截止实际到达后，显式生成一期；提前执行会拒绝且不入白名单。
node --env-file=.data/p5.env scripts/bounded-trial.ts daily --id p5-2026-10-03 --date 2026-10-03
node --env-file=.data/p5.env scripts/bounded-trial.ts freeze --id p5-2026-10-03
node --env-file=.data/p5.env scripts/bounded-trial.ts report --id p5-2026-10-03 --output .data/verification/p5/report.json
node --env-file=.data/p5.env scripts/bounded-trial.ts close --id p5-2026-10-03
```

初始化只允许具有 verified 配置且同时覆盖 RSS、网页和 sitemap 的 10–15 个来源。上述命令是显式有界试验，不是定时监控或历史 burn-in/soak。关闭前先结束仍在途的 worker 请求，再读取最终报告。

本机原始证据在 worktree 的 `.data/verification/p5/`，包括逐轮采集、迁移/测试日志、受控失败、worker 重启前后回执、账目与公开页面截图。包含原始响应及账户记录的文件保持本地；仓库只保留脱敏结果。

## 已核实的阶段结果

- 45 个迁移在独立空测试库应用；后端完整回归 634/634，包含关闭与付费预留竞争、未来日报拒绝、省略环境仍拒绝越界采集，以及回灌标识/今日新增统计。
- 首轮 14 个来源全部列表采集成功，每源导入 1 条历史资料。后续轮次继续按真实时间筛选，未删除回灌标记或调整发布时间。
- 注入一次本地合成 HTTP 503 后，BBC 失败记录可见且 cursor 不变；同一来源随后通过真实网络重试成功。此故障是受控注入，不宣称供应商真实宕机。
- worker 在 20 次已保存请求后停止并使用相同 cohort 重启；重启后已有 received 回执继续完成，attempts 保持 1。
- 真实新增的 CNN 社会稿与美联储财经稿已通过分类、中文写作、事实编排和公开读取。正常新增数量、最终费用、积压与日报结果以运行结束记录为准。
- 来源中文名称在公开 DTO、网页、RSS 与旧账本读取时统一兼容。回灌保留原始日期和精选决策，网页标记“历史收录”，今日新增只计正常增量；日报和通知继续排除回灌。
- 源文机器抽查发现 BBC 摘要把调查重启误写为“重新开庭”，已通过有审计记录的编辑更正修复，保留原分析与回执；由该编辑版本引发的后续处理仍计入本批费用。样本 ID、原文链接和未填写的人工标签见[样本表](../reference/trials/p5-2026-10-03-samples.json)。
- 在 worker 停止时打开真实新闻页、详情并运行 smoke，付费尝试前后均为 83，页面读取新增模型调用为 0。
- 本地 PostgreSQL 备份恢复到另一个隔离测试库后，19 张关键业务/回执表的行数和内容校验值一致；未恢复或覆盖生产库。该证据覆盖本次本地数据恢复，不替代 P6 的旧 Supabase 导出及生产回滚验证。
- 尚无 200 条人工标注金标准；机器抽查不能证明分类准确率、AI precision/recall 达到计划门槛。
