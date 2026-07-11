# Daily News 安全和隐私边界

## 文档目的

记录当前仓库已经体现的 secrets 处理、外部抓取、浏览器边界、公开数据边界和剩余风险，避免后续改动把密钥、私有配置或不可信内容暴露给前端。本文仅根据当前仓库可见内容整理；未在仓库中找到证据的内容均不做假设。

## 适用范围

适用于修改以下内容：

- `.env.local`、`.env`、`.env.example` 或环境变量读取；
- Firecrawl keyless、直接来源抓取或翻译服务；
- `/api/news`、`/api/health`、`/api/refresh`；
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
| Firecrawl key | 当前项目不要求 | 本地可用 keyless；固定生成和 Vercel refresh 禁用 Firecrawl；若未来引入 key，必须只留在 server-side |
| 新闻标题、摘要、来源、URL | 公开内容 | 可写入 `public/daily-news.json`，但要避免夹带 private token 或非公开内容 |
| 用户偏好 | 本地浏览器数据 | 存在 `localStorage`，不上传到服务端 |

## 信任边界

| 边界 | 规则 |
| --- | --- |
| 浏览器 <-> Node API | 浏览器只消费生成后的报告，不直接抓取 Firecrawl 或翻译服务 |
| Node API <-> 外部新闻来源 | Node 可以访问公开新闻网页/feed；失败应跳过而非泄露内部错误给页面 |
| Node API <-> 翻译服务 | 只有 Node 读取翻译配置；非中文内容没有翻译 API key 时跳过 |
| 生成产物 <-> 源数据 | `public/daily-news.json` 是公开生成产物，不是 secrets 或编辑源 |
| 社交/低可信来源 <-> UI | 低可信可展示但必须标记；极低质量不展示 |

## Secrets 处理

必须遵守：

- 不把 `.env.local`、`.env`、API key、token、Cookie 或私钥写入代码、日志、提交或聊天回复。
- 需要用户配置密钥时，只要求他们写入本地环境变量或 `.env.local`，不要让用户在聊天中贴明文。
- 前端代码不得引用 `process.env` 中的 secret，不得把 Firecrawl 或翻译调用移进浏览器。
- 文档可以写变量名和示例占位符，不能写真实值。

## 外部抓取和内容安全

当前抓取策略：

- 本地后台刷新可使用 Firecrawl keyless search；额度/限速/无结果时继续抓公开来源页面/feed。
- `npm run generate`、`npm run verify-news` 和 Vercel refresh 使用固定 direct-only profile，不调用 Firecrawl。
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

当前同时存在本地 Node API 与 Vercel Serverless API：

| 项 | 当前状态 | 风险 |
| --- | --- | --- |
| 本地监听 | `127.0.0.1` | 默认仅本机可访问；本地 refresh 允许无 token |
| CORS | 本地和 Serverless 均为 `*` | 任意站点可读取公开报告，仍需确认是否收紧 |
| Vercel `POST /api/refresh` | 必须配置 `DAILY_NEWS_REFRESH_TOKEN`；错误 token 返回 `401` | 尚无频控，token 仍需安全保管 |
| 错误信息 | Serverless 返回归一化错误；本地可返回 `lastError` | 本地错误可能包含外部失败细节，不应直接公网暴露本地服务 |
| 缓存 | bundled JSON + 进程内 latest | Serverless 跨实例不共享 latest，重启回到 bundled report |

Vercel refresh 已有 bearer token 与归一化错误；正式公开运维仍需确认 CORS、频率限制、日志和跨实例存储。

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
| 公开 API 被滥用刷新 | Vercel refresh 需要 bearer token | 尚无频控，token 泄露后仍可能被滥用 |
| 生成产物含错误或英文内容 | 中文过滤、DeepSeek 翻译配置和 `sourceLabel` 兜底 | 外部数据质量不可完全保证 |

## 非目标

- 不提供法律合规审计。
- 不提供事实核查保证。
- 不实现账号权限、审计日志、WAF、CDN 或生产密钥管理。
- 不绕过新闻网站访问控制。

## 实现指引

- 涉及 secrets 的改动先确认运行位置是 Node 还是浏览器。
- 涉及外部来源的改动先确认是否公开可访问、是否 paywall、是否需要中文翻译。
- 涉及 API 的改动同时检查本地 Node 与 Vercel Serverless 行为，不能只验证其中一种。
- 涉及保存数据的改动先确认是否会把用户偏好、密钥或非公开来源内容写入公开文件。

## 验收标准

- 搜索代码确认真实 key、token、Cookie 或 `.env.local` 值没有进入仓库。
- 前端 bundle 不包含翻译 key 或 Firecrawl key。
- `public/daily-news.json` 不包含 secrets。
- 外链继续使用 `rel="noreferrer"`。
- API 改动后仍能在本地通过 `/api/health` 和 `/api/news` 检查。

## 待确认

| 项 | 需要确认的问题 |
| --- | --- |
| 公开 API CORS 与 refresh 频控 | Vercel 入口与鉴权已存在，但是否限制读取来源、增加限流仍未确定 |
| 翻译服务长期供应商 | 当前默认 DeepSeek Flash；长期密钥管理、日志、成本和替代策略待确认 |
| 日志保留策略 | 当前只有 console warning/log，没有集中日志证据 |
| 来源准入政策 | 决定哪些来源可启用、禁用或仅使用公开元数据 |
| 是否允许分析用户行为 | 当前没有遥测；若新增必须单独设计和告知 |
