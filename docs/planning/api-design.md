# Daily News API 设计

## 文档目的

记录当前本地 HTTP API 的服务边界、请求方式、响应结构、错误行为和兼容性约束，供后续修改 `scripts/newsServer.ts` 或前端 API 消费时参考。本文仅根据当前仓库可见内容整理；未在仓库中找到证据的内容均不做假设。

## 适用范围

适用于 `/api/news`、`/api/health`、`/api/refresh` 和 API 到前端加载链路的改动。

不适用于外部新闻来源 API、Firecrawl 内部接口、翻译服务接口或未来生产网关，因为仓库没有稳定契约证据。

## Plan 或项目证据

| 证据 | API 事实 |
| --- | --- |
| `scripts/newsServer.ts` | 定义三个 API 路由、JSON 响应、CORS、no-store、404 和静态文件服务 |
| `src/App.tsx` | 前端只读取 `GET /api/news`，要求响应有非空 `items` 和字符串 `generatedAt` |
| `src/types.ts` | `DailyNewsReport` 类型定义了报告基础结构 |
| `README.md` | 公开说明 `/api/news` 和 `/api/health` |
| `docs/runbook.md` | smoke check 使用 `curl /api/health` 和 `curl /api/news` |
| `vite.config.ts` | Vite 开发服务将 `/api` 代理到 `http://127.0.0.1:4173` |

## API 总览

| Endpoint | Method | 作用 | 成功状态 |
| --- | --- | --- | --- |
| `/api/news` | `GET` | 返回当前缓存日报报告和刷新元数据 | `200` |
| `/api/health` | `GET` | 返回服务是否已有可用缓存、新闻数量和最近错误 | `200` 或 `503` |
| `/api/refresh` | `POST` | 手动触发一次刷新并返回最新生成时间 | `200` |
| `/api/*` 其他路径 | 任意 | API 未定义路径 | `404` |

服务默认监听 `127.0.0.1:4173`，可通过 `PORT` 环境变量覆盖。当前证据只说明本地 API，不说明公开生产域名。

## 通用响应规则

| 规则 | 当前行为 |
| --- | --- |
| 响应格式 | JSON |
| `Content-Type` | `application/json; charset=utf-8` |
| `Cache-Control` | `no-store` |
| CORS | `Access-Control-Allow-Origin: *` |
| API 路由外路径 | 在 `npm run serve` 下尝试托管 `dist/` 静态文件，找不到时 fallback 到 `index.html` 或 404 |

`Access-Control-Allow-Origin: *` 适合当前本地原型。若部署公开服务，需要重新评估来源限制和滥用风险。

## `GET /api/news`

### 目的

返回服务端内存中最新可用的 `DailyNewsReport`，供浏览器首选加载。

### 请求

无请求体。当前没有认证、分页、查询参数或版本参数。

### 成功响应

状态码：`200`

响应结构：

```ts
DailyNewsReport & {
  refresh: {
    intervalMinutes: number;
    lastError: string | null;
  };
}
```

核心字段：

| 字段 | 含义 |
| --- | --- |
| `generatedAt` | 报告生成时间，ISO 字符串 |
| `items` | 排序后新闻列表，元素为 `RankedNewsItem` |
| `sourceCount` | 本次报告涉及的来源数量 |
| `notes` | 面向读者的报告说明 |
| `refresh.intervalMinutes` | 服务端刷新间隔 |
| `refresh.lastError` | 最近一次刷新错误；无错误为 `null` |

`RankedNewsItem` 至少包含前端当前依赖的字段：`id`、`title`、`url`、`sourceNames`、`categories`、`primaryCategory`、`summary`、`publishedAt` 或 `extractedAt`、`score_breakdown`、`trust`。

### 未准备好响应

状态码：`503`

```json
{
  "error": "News report is still loading",
  "refresh": {
    "intervalMinutes": 15,
    "lastError": null
  }
}
```

`intervalMinutes` 取实际配置；示例中的 `15` 是默认值。

## `GET /api/health`

### 目的

给本地维护者检查 API 是否已有可用缓存，以及最近一次刷新是否报错。

### 请求

无请求体。当前没有认证、查询参数或版本参数。

### 响应

缓存存在时状态码为 `200`，缓存不存在时状态码为 `503`。

```ts
{
  ok: boolean;
  generatedAt: string | null;
  itemCount: number;
  lastError: string | null;
}
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `ok` | 是否已有可用 `cachedReport` |
| `generatedAt` | 缓存报告生成时间；无缓存为 `null` |
| `itemCount` | 当前缓存新闻条数；无缓存为 `0` |
| `lastError` | 最近刷新错误；无错误为 `null` |

## `POST /api/refresh`

### 目的

手动触发一次刷新，供维护者在本地 API 运行时立即更新缓存。

### 请求

无请求体。当前没有认证、幂等 key、查询参数或版本参数。

### 成功响应

状态码：`200`

```ts
{
  ok: true;
  generatedAt: string | null;
}
```

`generatedAt` 是刷新后缓存报告的生成时间；若刷新逻辑没有得到缓存，可能为 `null`。

### 失败响应

状态码：`500`

```ts
{
  ok: false;
  error: string;
}
```

## 认证和授权

当前 API 没有认证、授权、用户身份或权限边界。仓库证据显示它面向本地开发和生产式本地运行。

如果未来公开部署，至少需要确认：

- 是否限制 CORS；
- 是否保护 `POST /api/refresh`；
- 是否限制刷新频率；
- 是否记录访问日志并避免泄露错误细节；
- 是否需要 API 版本策略。

## 校验规则

当前 API 没有请求参数，因此主要校验在响应消费侧：

- `src/App.tsx` 的 `readReport` 要求 `items` 是非空数组；
- `src/App.tsx` 的 `readReport` 要求 `generatedAt` 是字符串；
- 不满足时前端会把该响应视为不可用并继续 fallback。

## 错误和状态码

| 场景 | 状态码 | 响应 |
| --- | --- | --- |
| `/api/news` 初始缓存未准备好 | `503` | `error` + `refresh` |
| `/api/health` 初始缓存未准备好 | `503` | `ok: false` |
| `/api/refresh` 刷新失败 | `500` | `ok: false` + `error` |
| 未定义 `/api/*` 路径 | `404` | `{ "error": "Not found" }` |
| 静态资源不存在且没有 `dist/index.html` | `404` | `{ "error": "Not found" }` |

## 兼容性说明

- 前端加载链路依赖 `/api/news`，但必须继续支持 `/daily-news.json` 和 `firecrawlSnapshotNews` fallback。
- 新增字段应保持向后兼容；前端不应要求 API 立即存在非必要字段。
- 删除或重命名 `DailyNewsReport` 字段会影响 `src/App.tsx`、静态 JSON 和测试 fixture。
- 如果 `/api/news` 允许空 `items`，需要同步修改前端 `readReport` 的有效性判断。

## 非目标

- 不定义 Firecrawl search 请求/响应契约。
- 不定义翻译服务的 OpenAI-compatible API 细节。
- 不定义生产负载均衡、CDN、日志系统或监控接口。
- 不实现用户认证、分页、服务端偏好或历史查询。

## 实现指引

- 改 `scripts/newsServer.ts` 前先确认是否影响 `src/App.tsx` 的 `readReport`。
- 新增 endpoint 时补充本文件，并在 `docs/runbook.md` 或 smoke check 中加入最小验证命令。
- 如果 API 改成公开可访问，先更新 [security-privacy.md](security-privacy.md) 中的 CORS、refresh 和错误信息风险。
- 保持 JSON 响应可被 `curl` 检查，方便本地排障。

## 验收标准

- `npm run api` 启动后，初始刷新完成时 `curl http://127.0.0.1:4173/api/health` 返回 `ok: true`。
- `curl http://127.0.0.1:4173/api/news` 返回非空 `items` 和字符串 `generatedAt`。
- `curl -X POST http://127.0.0.1:4173/api/refresh` 能触发刷新并返回 JSON。
- 未定义 `/api/*` 返回 404 JSON。
- 前端在 API 失败时仍能 fallback。

## 待确认

| 项 | 需要确认的问题 |
| --- | --- |
| 生产 API 域名 | 当前只有本地 `127.0.0.1:4173` |
| API 认证 | 当前无认证；公开部署前必须确认 |
| CORS 策略 | 当前为 `*`；公开部署是否允许任意来源待确认 |
| 刷新频率限制 | 当前 `POST /api/refresh` 无频控 |
| API 版本策略 | 当前没有 `/v1` 或版本字段 |
