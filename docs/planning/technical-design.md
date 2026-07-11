# Daily News 技术设计

## 文档目的

记录当前事件级 V2 的实现契约。修改来源、采集、选题、API、静态报告或前端时，应以本文和 [news-curation-refactor-plan.md](news-curation-refactor-plan.md) 的实施状态为准。

## 当前架构

```text
src/config/sources.ts
  -> src/lib/sourceCoverage.ts
  -> 调用方选择采集 profile：本地可 Firecrawl keyless + direct；固定生成/Serverless 为 direct-only
  -> 72 小时新鲜度与 30 秒整轮截止
  -> src/lib/curation.ts 质量门槛
  -> src/lib/dedupe.ts 事件聚类
  -> evidence / status / public impact / tier / diversity
  -> DailyNewsReport V2
  -> scripts/reportStore.ts 发布门槛与 last-known-good
  -> GET /api/news 只读
  -> src/App.tsx 事件级首页与分类引用
```

## 子系统职责

| 子系统 | 文件 | 当前职责 |
| --- | --- | --- |
| 来源注册表 | `src/config/sources.ts` | 来源、栏目、查询词、主分类、语言、地区、可信度和访问边界 |
| 覆盖调度 | `src/lib/sourceCoverage.ts` | 按未覆盖 beat、单入口 beat、来源类型、地区、可信度和可选健康状态选源 |
| 采集服务 | `scripts/newsService.ts` | Firecrawl/直连、中文化、发布时间、域名归因、并发、总预算、新鲜度和 fallback |
| 候选门槛 | `src/lib/curation.ts` | 拒绝缺身份/时间、模板摘要、推广内容 |
| 事件聚类 | `src/lib/dedupe.ts` | canonical URL、标题相似度、中文连续文本、时间窗和共享上下文聚类；唯一主分类 |
| 信任与兼容排序 | `src/lib/trust.ts`, `src/lib/scoring.ts` | 最低展示门槛和旧 `items` 的可解释排序；中文摘要使用语言感知信息量 |
| 事件选题 | `src/lib/curation.ts` | evidence、independence group、status、event type、公共影响、四级 tier 和多样性选择 |
| 报告管线 | `src/lib/newsPipeline.ts` | 输出 V2 `stories`、首页三层、sections、coverage、quality 和兼容 `items` |
| 报告存储 | `scripts/reportStore.ts` | bundled report 读取、V1→V2 升级、内存 latest、绝对/相对发布门槛 |
| API | `scripts/newsApi.ts`, `scripts/newsServer.ts` | 只读 `/api/news`、健康状态、受保护刷新和静态服务 |
| 静态发布 | `scripts/generateDailyNews.ts`, `scripts/upgradeDailyNewsReport.ts` | 质量门槛后原子替换；离线 V1→V2 迁移 |
| 前端 | `src/App.tsx` | 今日必知、重要进展、持续关注、分类深读、搜索、偏好与三级 fallback |

## 关键契约

### 报告

- `DailyNewsReport.version` 固定为 `2`。
- `stories` 是所有正式事件的规范集合。
- `topStories`、`importantStories`、`watchlist` 是首页子集，同一事件不能跨层重复。
- `sections.storyIds` 必须全部能在 `stories` 中解析。
- `items` 是迁移期兼容字段，仍包含 `score_breakdown`、`trust`、`primaryCategory` 等 V1 消费字段。

### 事件选择

- `must_know` 由独立公共影响模型决定，不能使用个人偏好加分。
- 用户偏好只调整 `importantStories` 和分类深读顺序。
- 单一社交线索只能进入 `unverified`/watchlist，不能进入核心层。
- 体育和娱乐可作为 `special_interest` 保留在分类页，但时效与信源数量不能单独把预测/评论推入 must-know。
- 没有合格事件的栏目允许为空，并显示明确空状态；禁止用 noise 填数。

### 抓取与可靠性

- 整轮默认预算为 `DAILY_NEWS_COLLECTION_BUDGET_MS=30000`。
- 本地后台刷新默认选择全部启用来源，可先用 Firecrawl keyless（最多前 8 秒），候选少于 `max(8, maxSources)` 时继续直连并合并。
- `npm run generate`、`npm run verify-news` 和 Vercel refresh 固定选择 10 个来源、每分区 3 条、关闭 Firecrawl 与模型摘要修复，并执行 `reportAcceptance` 量化门槛。
- 直连来源并发默认 `DAILY_NEWS_SOURCE_CONCURRENCY=6`；单请求最长 8 秒且受整轮 deadline 约束。
- 固定 profile 若未达到 10/10 主分类覆盖、中文/新鲜度/时间顺序或请求/翻译预算，不能发布；`reportStore` 还会拒绝绝对无效、事件少于 10、来源少于 3 或丢失既有核心 beat 候选的报告。
- `GET /api/news` 不允许触发外部抓取。

### 安全

- 浏览器不得读取 Firecrawl、翻译或刷新凭据。
- Vercel 的 `POST /api/refresh` 需要 `DAILY_NEWS_REFRESH_TOKEN`；未配置返回 `503`，错误凭据返回 `401`。
- 不绕过登录、付费墙或访客验证；只保存公开标题、摘要、时间、URL 和最小证据元数据。

## 前端状态流

```text
/api/news V2
  -> /daily-news.json（V2；V1 会在浏览器升级）
  -> firecrawlSnapshotNews
```

- 首页今日必知顺序不受偏好影响。
- 重要进展和分类页用兼容 item 的个性化分数重排对应 `StoryCard`。
- 搜索作用于事件标题、发生了什么、重要性解释、来源、beat 和 event type。
- 分类页直接渲染 `stories`，不重新生成文章卡片。

## 编辑部式极简前端

### 文档目的

把已确认的 UI 方案固化为可验证的实现约束。目标用户需要在进入页面后优先看到新闻，而不是先理解导航、系统状态或容器层级。

### 适用范围

- `src/App.tsx` 的页面结构、导航、搜索、设置入口、新闻层级和状态反馈；
- `src/styles.css` 的视觉令牌、桌面和移动端布局、深色模式与低动效；
- 不改变 `DailyNewsReport`、分类、排序、可信度、偏好权重或三层 fallback 顺序。

### 选定方案

- 删除桌面侧栏，分类入口只保留在单一顶部导航中；所有现有分类名称和 `activeView` 行为保持不变。
- 顶部由品牌、日期、搜索、刷新、设置和可横向滚动的分类导航组成；移动端搜索按需展开。
- 页面标题、更新时间和质量概览压缩为首屏信息带，避免营销式 hero 和大面积深色指标卡。
- 今日必知采用“首条主新闻 + 其余紧凑列表”；重要进展和持续关注采用单列新闻流。
- 新闻默认展示状态、分类、时间、标题、短摘要、重要性和来源；关键事实与后续关注点通过原生 `details` 渐进披露。
- 视觉使用单一青绿色强调色、冷灰中性色、8px 圆角、细分隔线和系统中文字体；不使用渐变、外发光或装饰性图片。
- 动效强度保持为 2，只允许 hover、按下反馈、刷新旋转和原生展开状态；尊重 `prefers-reduced-motion`。
- 使用 CSS 变量同时定义亮色和系统深色主题，不增加独立主题切换控件。

### 状态与失败处理

- 首次读取且尚无已加载报告时，显示与最终新闻流同形的骨架屏。
- API 降级到静态或本地数据时，在内容顶部显示紧凑信息条，新闻仍可阅读。
- 搜索无结果时说明当前筛选条件，并提供清除搜索操作。
- 分类无合格事件时保持明确空状态，不使用低质量新闻填充。

### 非目标

- 不改新闻采集、翻译、事件聚类、分类、排序、可信度或报告 schema；
- 不新增 UI 框架、动画库、字体服务或第三方图片请求；
- 不修改 URL、API 路由、环境变量或部署流程。

### 验收标准

- 页面只有一套分类导航，桌面导航单行显示，窄屏可横向滚动；
- 桌面首屏无需滚动即可看到今日必知内容；
- 390px 移动端首屏能看到第一条新闻标题，页面无横向溢出；
- 新闻标题、时间、来源和重要性在默认收起状态下可快速识别；
- 加载、搜索空结果、空分类和 fallback 信息都有独立且可读的状态；
- 搜索、分类切换、刷新、设置和偏好按钮均有键盘焦点样式与足够触控尺寸；
- 亮色和系统深色模式均保持 WCAG AA 可读对比；
- `npm test` 与 `npm run build` 通过，浏览器完成桌面和 390px 人工验收。

## 仍未完成

- 7–14 天人工 golden dataset 与 must-know 召回/精确率校准；
- 连续 7 天 shadow 对比和生产灰度；
- 外部生产 `NewsStore`、候选/事件历史表、来源健康持久化和历史日报 API；
- 生产调度器、日志聚合、告警和真实 P95 dashboard；
- 人工事件合并/拆分和更正后台。

## 验收

- `npm test`；
- `npm run build`；
- `npm run upgrade-report` 后验证 section/story/item 引用完整；
- `curl /api/news` 返回 V2 且读取路径不访问外部网络；
- 浏览器检查桌面和 390px：三层首页、分类引用、空分类、搜索、设置、fallback 与控制台。
