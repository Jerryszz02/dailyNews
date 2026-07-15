# Daily News 安全和隐私边界

## 文档目的

记录当前仓库已经体现的 secrets 处理、外部抓取、浏览器边界、公开数据边界和剩余风险，避免后续改动把密钥、私有配置或不可信内容暴露给前端。本文仅根据当前仓库可见内容整理；未在仓库中找到证据的内容均不做假设。

## 适用范围

适用于修改以下内容：

- `.env.local`、`.env`、`.env.example` 或环境变量读取；
- Firecrawl keyless、直接来源抓取或翻译服务；
- `/api/news`、`/api/health`、`/api/refresh`；
- `/api/cron`、Supabase migrations、RPC 和 Cron/Vault 配置；
- `public/daily-news.json` 和 `src/data/firecrawlSnapshot.ts`；
- 前端加载、展示外部链接、来源名、可信度标签和错误提示。

## Plan 或项目证据

| 证据 | 安全/隐私事实 |
| --- | --- |
| `AGENTS.md` | 不粘贴 Firecrawl key 或 `.env.local` 值；Firecrawl/API key 使用 server-side；API 路由保持 server-only |
| `README.md` | 翻译密钥只在 Node 服务端读取，前端不接触密钥 |
| `docs/architecture.md` | 浏览器不读取 `.env`、`.env.local` 或翻译凭据 |
| `scripts/newsService.ts` | `loadLocalEnv()` 读取 `.env.local` 和 `.env`；有 `DAILY_NEWS_TRANSLATION_API_KEY` 时使用 DeepSeek Flash 默认翻译配置 |
| `scripts/newsServer.ts` | API 响应 `Access-Control-Allow-Origin: *`，本地服务监听 `127.0.0.1` |
| `src/App.tsx` | 前端只 fetch `/api/news` 和 `/daily-news.json`，外链使用 `target="_blank"` 和 `rel="noreferrer"` |
| `src/lib/trust.ts` | 社交媒体单点信息降权并标记低可信；缺少标题或 URL 的内容不展示 |

## 敏感数据和数据分级

| 数据 | 分级 | 当前处理 |
| --- | --- | --- |
| `DAILY_NEWS_TRANSLATION_API_KEY` | secret | 只应存在本地环境变量或 `.env.local`；Node 侧读取；不能提交或粘贴 |
| `DAILY_NEWS_TRANSLATION_BASE_URL` | 配置 | 可指向本地或云端 OpenAI-compatible 服务；不包含密钥时可公开说明 |
| `DAILY_NEWS_TRANSLATION_MODEL` | 配置 | 模型名不是 secret，但可能暴露供应商选择 |
| `.env.local`, `.env` | 本地配置 | 不应提交或写入文档正文 |
| Firecrawl key | 当前项目不要求 | 代码使用 keyless；若未来引入 key，必须只留在 server-side |
| 新闻标题、摘要、来源、URL | 公开内容 | 可写入 `public/daily-news.json`，但要避免夹带 private token 或非公开内容 |
| 用户偏好 | 本地浏览器数据 | 存在 `localStorage`，不上传到服务端 |
| `SUPABASE_URL` | 服务端配置 | 可由 Vercel Function 使用；当前前端不需要它 |
| `SUPABASE_SECRET_KEY` | 高权限 secret | 仅 Vercel/本地 Node 服务端；绝不能使用 `VITE_` 前缀或进入 bundle |
| `CRON_SECRET` / `DAILY_NEWS_REFRESH_TOKEN` | 调度/运维 secret | 只用于服务端 endpoint 鉴权；Supabase Cron 通过 Vault 读取，不写 migration 明文 |
| Supabase database password/PAT | 部署 secret | 只用于 CLI 交互或临时环境，不是生产应用 runtime 配置 |

## 信任边界

| 边界 | 规则 |
| --- | --- |
| 浏览器 <-> Node API | 浏览器只消费生成后的报告，不直接抓取 Firecrawl 或翻译服务 |
| Node API <-> 外部新闻来源 | Node 可以访问公开新闻网页/feed；失败应跳过而非泄露内部错误给页面 |
| Node API <-> 翻译服务 | 只有 Node 读取翻译配置；非中文内容没有翻译 API key 时跳过 |
| Node API <-> Supabase | 只有服务端 secret client 经 Data API/RPC 访问；浏览器不持有 publishable 或 secret key |
| Supabase Cron <-> Node API | `pg_net` 从 Vault 读取 URL/secret，调用受保护 GET；迁移只保存 Vault secret 名称 |
| 生成产物 <-> 源数据 | `public/daily-news.json` 是公开生成产物，不是 secrets 或编辑源 |
| 社交/低可信来源 <-> UI | 低可信可展示但必须标记；极低质量不展示 |

## Secrets 处理

必须遵守：

- 不把 `.env.local`、`.env`、API key、token、Cookie 或私钥写入代码、日志、提交或聊天回复。
- 需要用户配置密钥时，只要求他们写入本地环境变量或 `.env.local`，不要让用户在聊天中贴明文。
- 前端代码不得引用 `process.env` 中的 secret，不得把 Firecrawl 或翻译调用移进浏览器。
- 不创建 `VITE_SUPABASE_SECRET_KEY`、`VITE_CRON_SECRET` 或任何等价高权限前端变量。
- Supabase client 必须关闭 session 持久化、自动 token 刷新和 URL session 检测；只在 `scripts/`/`api/` 服务端代码初始化。
- 文档可以写变量名和示例占位符，不能写真实值。

## 外部抓取和内容安全

当前抓取策略：

- Firecrawl 使用 keyless search。
- Firecrawl 额度/限速/无结果时直接抓公开来源页面/feed。
- 直接抓取设置 8 秒超时。
- 单个来源失败只记录 warning 并继续。
- 非中文内容在没有翻译 API key 时跳过，以维护中文体验。

后续修改应避免：

- 绕过 paywall 或访问需要登录/访客验证的正文；
- 保存或展示非公开内容；
- 把来源返回的 HTML 直接注入页面；
- 把外部错误详情、密钥或请求头写入用户可见响应；
- 让一个来源失败导致整份日报不可用。

## API 安全边界

当前项目同时有本地 Node 服务和公开 Vercel Functions。只读报告可公开；刷新与调度必须鉴权：

| 项 | 当前状态 | 风险 |
| --- | --- | --- |
| 监听/部署 | 本地 `127.0.0.1`；生产 Vercel 公网 | 公开入口必须按 endpoint 分权 |
| CORS | 当前 `*` | 只读报告可跨域；写/刷新路由仍依赖 bearer token，后续可收紧 origin |
| `POST /api/refresh` | production 使用 `DAILY_NEWS_REFRESH_TOKEN` | 未配置 503，错误/缺失 401；仍需数据库租约防重入 |
| `GET /api/cron` | `CRON_SECRET` + Supabase lease | 只有调度器可触发；同一时间槽重试幂等 |
| 错误信息 | 仅归一化 error code | 不返回 SQL、外部响应、连接字符串或 secret |
| 持久化 | Supabase server-only tables | RLS + 无 anon/authenticated policy；快照和候选只保存公开最小元数据 |

生产启用前必须完成 RLS/execute grant、refresh/cron 鉴权、错误脱敏和并发租约验收。只读 CORS 与限流策略可继续独立收紧，但不能阻塞 server-side 安全边界。

## Supabase 权限契约

- internal schema/table 全部启用 RLS，且不给 `anon` 或 `authenticated` 创建 policy；
- RPC 显式 `REVOKE EXECUTE FROM PUBLIC, anon, authenticated`，只授予服务端角色；
- 函数使用最小 search path 和全限定表名，禁止把任意 SQL、schema 或 URL 当作用户输入；
- report snapshot 发布后不可原地 UPDATE/DELETE，更正和回滚只切换 pointer；
- 应用运行时使用 `SUPABASE_URL` + 新式 `SUPABASE_SECRET_KEY`，不新增 legacy service-role key；
- 数据库迁移文件、pgTAP、日志和 API 响应只能出现变量名或占位符，不能出现真实 key、Vault 值或项目密码。
- 托管 Supabase 的 `pg_net`/Vault 对象由平台保留角色管理，项目 migration 不能把平台 owner ACL 当作应用权限边界；生产必须使用 publishable key 验证 `net`、`vault`、`daily_news` 均不在 PostgREST exposed schemas（期望 `406/PGRST106`），并验证未授权 Daily News RPC 返回 `401/42501`。
- `pg_net` 会在请求完成前把 URL/header 放入内部 unlogged queue；Cron secret 因此只能写入 Vault 并由数据库任务读取，不能进入应用日志、报告、公开错误或项目文件。

## 隐私约束

当前可确认隐私事实：

- 用户偏好只保存在浏览器 `localStorage`。
- 服务端没有账号、用户标识、会话、数据库或行为分析证据。
- 前端外链使用 `rel="noreferrer"`，减少向目标站点传递 referrer。
- 项目没有遥测、埋点或后台数据收集证据。

如果未来添加账号、分析、日志或云端部署，需要新建或更新隐私说明。

## 威胁、缓解措施和剩余风险

| 威胁 | 当前缓解 | 剩余风险 |
| --- | --- | --- |
| secret 泄露到浏览器 | secret 只在 Node 脚本读取；文档禁止粘贴真实值 | 未来改前端抓取时可能破坏边界 |
| 不可信新闻误导用户 | `trust` 评分、低可信标签、社交单点降权、极低质量过滤 | 可信度规则是启发式，不等于事实核验 |
| Paywall/验证站点不稳定 | 不可靠来源可禁用；付费墙来源只用公开元数据 | 来源政策变化会导致抓取失败或内容稀疏 |
| 公开 API 被滥用刷新 | bearer token、数据库租约、同时间槽幂等 | token 泄露后仍可能产生额度消耗；需轮换和日志告警 |
| Supabase 高权限 key 泄露 | 仅服务端环境、RLS 防误配、bundle/仓库扫描 | secret key 本身可绕过 RLS，必须限制环境 scope 并支持轮换 |
| 生成产物含错误或英文内容 | 中文过滤、DeepSeek 翻译配置和 `sourceLabel` 兜底 | 外部数据质量不可完全保证 |

## 非目标

- 不提供法律合规审计。
- 不提供事实核查保证。
- 不实现账号权限、审计日志、WAF、CDN 或生产密钥管理。
- 不绕过新闻网站访问控制。

## 实现指引

- 涉及 secrets 的改动先确认运行位置是 Node 还是浏览器。
- 涉及外部来源的改动先确认是否公开可访问、是否 paywall、是否需要中文翻译。
- 涉及 API 的改动先确认是否仍只用于本地；若要公开部署，先更新 API 与安全文档。
- 涉及保存数据的改动先确认是否会把用户偏好、密钥或非公开来源内容写入公开文件。

## 验收标准

- 搜索代码确认真实 key、token、Cookie 或 `.env.local` 值没有进入仓库。
- 前端 bundle 不包含翻译 key 或 Firecrawl key。
- 前端 bundle 不包含 Supabase secret、cron token、数据库连接字符串或 Vault 值。
- `public/daily-news.json` 不包含 secrets。
- anon/authenticated 对 Supabase internal tables/RPC 的读写测试全部失败，server role contract 测试通过。
- publishable key 访问 `net`、`vault`、`daily_news` schema 均被 PostgREST 拒绝，未授权 public RPC 也被拒绝。
- `/api/refresh` 与 `/api/cron` 的未配置、未授权、并发和错误脱敏测试通过。
- 外链继续使用 `rel="noreferrer"`。
- API 改动后仍能在本地通过 `/api/health` 和 `/api/news` 检查。

## 待确认

| 项 | 需要确认的问题 |
| --- | --- |
| 只读 API 的最终 CORS/限流 | 当前公开报告不含用户数据；正式流量与滥用情况决定是否收紧 |
| 翻译服务供应商 | 决定密钥管理、日志、成本和数据发送边界 |
| 日志保留策略 | 当前只有 console warning/log，没有集中日志证据 |
| 来源准入政策 | 决定哪些来源可启用、禁用或仅使用公开元数据 |
| 是否允许分析用户行为 | 当前没有遥测；若新增必须单独设计和告知 |
| secret 轮换和 incident owner | 上线前需确认由谁维护 Supabase/Vercel/Vault secret 和泄露响应 |
