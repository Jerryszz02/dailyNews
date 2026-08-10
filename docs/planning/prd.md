# Daily News 产品需求文档

## 文档目的

定义当前仓库已经实现或明确约束的用户可见行为，帮助后续开发在不重新解读代码的情况下判断改动是否符合产品边界。本文仅根据当前仓库可见内容整理；未在仓库中找到证据的内容均不做假设。

## 适用范围

适用于修改 Daily News 前端展示、事件选题、分类筛选、偏好设置、搜索、证据状态、数据 fallback 体验和中文化边界的工作。

数据库与生产部署的实现约束分别由 [database-design.md](database-design.md)、[technical-design.md](technical-design.md) 和 [release-plan.md](release-plan.md) 维护。本文不定义商业化、账号体系、通知系统或用户可见历史归档。

## Plan 或项目证据

| 证据 | 可确认需求 |
| --- | --- |
| `README.md` | 项目是事件级新闻日报；展示今日必知、重要进展、持续关注和分类深读 |
| `src/App.tsx` | 前端入口包含事件分层、分类导航、设置、搜索、质量概览和手动刷新 |
| `src/types.ts` | V2 报告包含 `stories`、三个首页层、`sections`、`coverage`、`quality` 和兼容 `items` |
| `src/lib/curation.ts` | 实现质量门槛、证据状态、公共影响分级、多样性和不填充原则 |
| `src/lib/sourceCoverage.ts` | 在有限来源预算内补齐 beat，并优先为单入口 beat 增加第二来源 |
| `AGENTS.md` | 用户侧页面 copy、新闻标题、摘要、来源名应保持中文；分类页使用 `primaryCategory` |

## 产品目标

Daily News 要解决的问题是：让用户在 10–15 分钟内掌握当天最重要的事件、发生了什么、为什么重要、有哪些来源证据以及下一步关注什么，而不需要在多个新闻网站之间补齐基本信息。

本轮确认的首要目标是“完整、稳定、状态真实”，而不是让运行时信任分数再次决定新闻是否存在。当前可确认目标：

| 目标 | 说明 |
| --- | --- |
| 多来源聚合 | 从 `src/config/sources.ts` 中启用的来源抓取或读取新闻 |
| 中文阅读体验 | 面向用户的页面文案、新闻标题、摘要和来源名尽量保持中文 |
| 事件去重 | 同一现实事件只生成一个 `StoryCard`，多个报道进入 evidence |
| 重要性分层 | 先区分 must-know/important/special-interest/noise，再在层内排序 |
| 信任提示 | 区分 confirmed/developing/unverified 等事实状态并展示来源证据 |
| 分类不重复 | 每个事件只有一个 `primaryBeat`，分类页引用规范 `stories` 集合 |
| 偏好控制 | 偏好只调整重要进展和分类深读顺序，不能隐藏或提升 must-know |
| 全部最新 | 首页首屏按 `updatedAt` 展示最近 24 小时全部有效事件；精选层只做补充 |
| 单次准入 | 来源是否可信只在注册表新增或修改时审核，运行时不再按 credibility/trust 删除或降出可见集合 |
| 成本控制轮转 | 生产每 2 小时运行一轮、每轮最多 11 源；49 个启用来源约 10 小时完成一次真实采集轮转 |
| 状态分轴 | 服务可用性、采集覆盖、内容年龄分别展示，quiet/stale 不等于服务不可用 |

## 用户和使用场景

| 用户或角色 | 当前证据 | 使用场景 |
| --- | --- | --- |
| 新闻阅读者 | `src/App.tsx` 的事件首页、分类、搜索和偏好设置 | 先读今日必知，再按需要查看重要进展、持续关注或某个分类 |
| 本地维护者 | `README.md`, `docs/runbook.md`, npm scripts | 配置来源、生成静态日报、启动本地 API、验证排序和展示 |
| 来源维护者 | `src/config/sources.ts` | 新增、禁用或调整来源、栏目、查询词、主分类和可信度 |
| 生产维护者 | `scripts/productionAcceptanceMonitor.ts`, `supabase/migrations/`, `docs/runbook.md` | 迁移、部署、调度、回滚和连续运行验收 |

目标用户是否是单人自用、内部工具还是公开产品：待确认。

## 功能需求

| 编号 | 需求 | 验收方式 |
| --- | --- | --- |
| PRD-1 | 应优先从 `GET /api/news` 加载新闻报告，失败后加载 `/daily-news.json`，再失败后使用 `src/data/firecrawlSnapshot.ts` | 断开 API 时页面仍有兜底新闻 |
| PRD-2 | 页面必须提供“今日简报”、十个分类入口和“设置”入口 | 检查 `src/App.tsx` 导航和页面可见文本 |
| PRD-3 | 分类页必须引用 `stories` 中唯一 `primaryBeat`，不能复制生成第二个事件 | 检查 section story ID 完整性和分类浏览器测试 |
| PRD-4 | 今日必知不使用个人偏好权重；偏好只调整重要进展和分类深读顺序 | `src/lib/curation.test.ts` 通过 |
| PRD-5 | 首页先展示最近 24 小时“全部最新”，初始 20 条、每次继续加载 20 条；今日必知、重要进展、持续关注保留在下方 | 检查 latest 完整性、顺序和分页 |
| PRD-6 | 页面必须支持搜索事件标题、事实、来源、主 beat 和 event type | 在页面搜索框输入关键词能过滤事件 |
| PRD-7 | 事件卡必须显示状态、主 beat、证据数、标题、发生了什么、公共影响解释、来源和后续关注点 | 检查 `EventCard` 展示字段 |
| PRD-8 | 用户偏好保存在浏览器 `localStorage`，刷新页面后保留 | 修改偏好后刷新页面仍保留设置 |
| PRD-9 | 只拒绝未准入/越域来源、缺标题或 URL、非法 URL、导航页和明确推广；缺摘要、日期或翻译属于可见降级状态 | 候选 disposition 与来源准入测试通过 |
| PRD-10 | 固定 UI 文案保持中文；翻译失败时原文立即发布并标记“待翻译”，来源名继续使用 `sourceLabel` 兜底 | 翻译失败 fixture 和页面检查 |
| PRD-11 | 每个有效候选必须映射到且只映射到一个 `story`；最近 24 小时有效事件必须全部进入 `latestStories` | 报告结构不变量测试通过 |
| PRD-12 | 局部来源失败、无新稿或精选层无新事件不能阻断其它合法新闻发布 | refresh partial/unchanged 集成测试通过 |

## 非功能需求

| 维度 | 要求 |
| --- | --- |
| 可维护性 | 新来源和分类规则应优先在 `src/config/sources.ts` 和相关类型中显式配置 |
| 可解释性 | 排序和可信度必须保留人可读原因，不能只给分数 |
| 降级能力 | API、Firecrawl、直接来源抓取或翻译不可用时，应尽量保留静态/快照可读内容 |
| 数据最小化 | 浏览器不接触 `.env`、`.env.local` 或翻译密钥 |
| 可靠读取 | API 启动即读取 last-known-good，浏览请求不等待外部抓取 |

## 状态和边界情况

| 状态 | 当前行为 |
| --- | --- |
| API 正常 | 前端使用 `/api/news` 的 `DailyNewsReport` |
| API 不可用 | 前端加载 `/daily-news.json`，再兜底 `firecrawlSnapshotNews` |
| 加载中 | 刷新按钮显示旋转状态 |
| 加载失败 | 保留较新的 last-known-good，同时单独更新 `servingMode/pipelineStatus/contentStatus` 和中文降级提示 |
| 无搜索结果 | 页面显示“没有匹配当前搜索的事件。” |
| 分类事件较多 | 通过“展开更多”每次增加 18 个事件 |
| 英文来源未翻译 | 原文立即展示并标记“待翻译”，后续刷新补齐中文，不因翻译服务失败丢稿 |
| 无新内容 | 成功完成检查并返回 `unchanged/quiet`，不显示“服务异常” |
| 局部来源失败 | 其它来源新事件继续发布；coverage 标记 degraded 并优先重试失败来源 |

## 非目标

- 不实现账号、登录、权限、跨设备同步或服务端保存偏好。
- 生产数据库只服务刷新运行态与 last-known-good；不提供用户可见历史日报、全文归档或长期检索。
- 不绕过付费墙；付费墙来源只使用公开标题、导语和元数据。
- 不把 Firecrawl 或翻译密钥暴露给浏览器。
- 不把 `public/daily-news.json` 当作编辑源数据。
- 不把事实状态标签等同于来源准入；单一社交线索可以显示为 unverified，但不能被静默删除。

## 实现指引

- 改新闻来源、查询词、栏目、主分类、可信度或启用状态时，优先修改 `src/config/sources.ts`。
- 改事件层级和理由时，检查 `src/lib/curation.ts` 及其测试；兼容 `items` 排序仍由 `src/lib/scoring.ts` 负责。
- 改来源治理时，只在 `src/config/sources.ts` 处理 admission、allowed hosts 与审核说明；`trust.shouldShow` 仅保留为兼容字段且不得过滤。
- 改分类页行为时，保持 `StoryCard.primaryBeat` 是唯一分类入口；`sections.storyIds` 必须能在 `stories` 中解析。
- 改 UI 文案时，保持中文；如果外部来源名可能为英文，保留或扩展 `src/App.tsx` 的 `sourceLabel` 兜底。
- 改 fallback 体验时，保持 `/api/news` -> `/daily-news.json` -> `firecrawlSnapshotNews` 的用户可读降级链。

## 验收标准

- `npm test` 通过。
- 前端或 TypeScript 改动后 `npm run build` 通过。
- 页面能打开并先展示全部最新，再展示今日必知、重要进展、持续关注、分类事件、搜索和偏好设置。
- 有效候选到 stories、24 小时 stories 到 latest 的映射率均为 100%，`unmappedCandidateCount=0`。
- 2 小时调度下，每轮最多选择 11 个到期来源，约 10 小时完成全部启用来源轮转。
- API 不可用时页面仍显示静态或快照新闻。
- 用户侧新增文案和保存的新闻内容为中文，或有明确翻译/兜底策略。

## 待确认

| 项 | 需要确认的问题 |
| --- | --- |
| 目标用户 | 该原型面向个人自用、团队内部还是公开读者 |
| 内容覆盖范围 | 是否只覆盖当前十类，还是未来要增加更多类别 |
| 长期内容 SLA | 当前为 Hobby 成本控制模式：2 小时调度、约 10 小时全来源轮转；迁移到自有服务器或付费计算后是否恢复更高频率待确认 |
| 付费墙来源策略 | 是否未来允许重新启用 Reuters、Bloomberg、FT、WSJ、The Athletic 等当前被禁用或不可靠的来源 |
| 历史数据 | 是否需要保存每天日报或支持按日期回看 |
