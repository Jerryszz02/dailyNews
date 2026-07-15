# Daily News API 设计

## 当前边界

API 只负责读取或刷新已经生成的事件级报告。外部来源抓取不能发生在 `GET /api/news` 请求路径中。Phase 2 以 Supabase 保存跨实例状态，并新增受保护的定时入口；浏览器仍只调用只读 endpoint。

## Endpoint

| Endpoint | Method | 作用 | 成功状态 |
| --- | --- | --- | --- |
| `/api/news` | `GET` | 立即返回 last-known-good V2 报告 | `200` |
| `/api/health` | `GET` | 报告可用性和最近刷新状态 | 仅 `fresh` 返回 `200`；`degraded`、`stale`、`unavailable` 返回 `503` |
| `/api/refresh` | `POST` | 运行一次受保护刷新，质量达标后切换 latest | `200` |
| `/api/cron` | `GET` | 供生产调度器触发同一刷新流程 | `200` 或 `202` |

其他 `/api/*` 路径在本地 Node 服务中返回 `404` JSON。

## 通用规则

- 响应为 UTF-8 JSON。
- 当前 CORS 为 `Access-Control-Allow-Origin: *`。
- 成功 `/api/news` 默认保持完整 V2 兼容响应；网页使用 `view=web` 紧凑表示，在客户端水合回完整 V2。自动轮询用 30 秒时间桶共享 CDN；主动重载固定请求 `view=web&reload=1`，浏览器返回 `no-store`，Vercel 边缘只缓存 5 秒以限制公开直读 Supabase 的频率。
- `/api/health`、受保护 refresh/cron、错误与 unavailable 响应继续 `Cache-Control: no-store`；报告不包含用户个性化或敏感数据。
- 公开错误只返回归一化信息，不返回外部响应正文、secret 或 translation 配置。

`GET /api/news` 只接受有限组合：可选且唯一的 `view=web`；再配无 cache 参数、`window=<无前导零的规范整数>` 或 `reload=1` 三者之一。window 不得偏离当前超过 2 个桶；reload 使用固定 5 秒边缘键。未知、重复、冲突、非规范、过期或超前参数均在读取 durable storage 前返回 `400 + no-store`。

## `GET /api/news`

返回 `DailyNewsReport` V2 与刷新元数据：

```ts
interface DailyNewsReportV2 {
  version: 2;
  generatedAt: string;
  window: { from: string; to: string };
  stories: StoryCard[];
  topStories: StoryCard[];
  importantStories: StoryCard[];
  watchlist: StoryCard[];
  sections: Array<{ beat: Category; storyIds: string[] }>;
  coverage: CoverageSummary;
  quality: PublicQualitySummary;
  items: RankedNewsItem[];
  sourceCount: number;
  notes: string[];
  refresh: {
    reportId: string | null;
    intervalMinutes: number;
    status: "fresh" | "stale" | "degraded" | "unavailable";
    dataAsOf: string | null;
    newestContentAt: string | null;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    staleAfterMinutes: number;
    lastError: string | null;
  };
}
```

契约：

- `stories` 是规范事件集合；
- 三个首页数组互不重复，且成员也来自同一事件模型；
- 每个 `sections.storyIds` 必须能在 `stories` 中解析；
- `items` 是迁移期 V1 兼容投影；
- `coverage` 和 `quality` 只包含可公开聚合，不包含内部抓取错误或凭据；
- `dataAsOf` 与报告真实 `generatedAt` 一致；fallback 不能把旧内容重写成当前时间；
- `newestContentAt` 来自事件 `updatedAt`、`publishedAt` 与 evidence `publishedAt` 的最大活动时间；`lastAttemptAt` 和 `lastSuccessAt` 来自 Supabase durable state；
- `fresh` 表示成功报告年龄不超过 30 分钟；超出即为 `stale`，数据库不可用但仍有 bundled 报告时为 `degraded`。

若没有任何 bundled、memory 或 snapshot 报告，返回 `503`。正常部署和本地启动会先加载 bundled last-known-good，因此不需要等待首次外部刷新。

## `GET /api/health`

```ts
{
  ok: boolean;
  reportAvailable: boolean;
  refreshStatus: "fresh" | "stale" | "degraded" | "unavailable";
  generatedAt: string | null;
  dataAsOf: string | null;
  latestReportId: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  ageMinutes: number | null;
  staleAfterMinutes: number;
  itemCount: number;
}
```

响应只可包含归一化 `lastError`；刷新失败不会使已有报告变成不可读，但不能继续报告 healthy/fresh。健康判断必须基于持久时间，而不是某个函数进程中的 `lastRefreshError`。

## `POST /api/refresh`

### 本地

非 production、非 Vercel 环境允许无 token 手动刷新，便于开发。

### Vercel / production

设置 `DAILY_NEWS_REFRESH_TOKEN`，请求头为：

```http
Authorization: Bearer <token>
```

| 场景 | 状态 |
| --- | ---: |
| Vercel 未配置 token | `503` |
| token 错误或缺失 | `401` |
| 生成报告未通过发布门槛 | `422` |
| 刷新内部失败 | `500`，公开响应不含内部错误正文 |
| 刷新并发布成功 | `200`，返回 `generatedAt` 和 `itemCount` |

发布门槛同时检查绝对有效性和相对防回退：事件/核心层/来源不能严重坍缩，之前已覆盖的核心 beat 不能突然没有任何候选。

## `GET /api/cron`

生产调度器发送：

```http
Authorization: Bearer <CRON_SECRET>
```

契约：

- 未配置 secret 返回 `503`，缺失或错误返回 `401`；
- 首先通过 Supabase RPC 获取有过期时间的刷新租约；已有活动 run 时返回 `202`，不重复抓取；
- 获取租约后与手动 refresh 共用同一管线，不维护第二套生成逻辑；
- 成功返回 run ID、`generatedAt` 和公开计数；失败只返回归一化错误码；
- 调度器重试必须幂等，质量失败或无合格实时数据不得切换 latest。

## 前端兼容

加载顺序固定为：

1. `/api/news`；
2. `/daily-news.json`；
3. `firecrawlSnapshotNews`。

前端可读取 V1 静态 `items` 并在内存升级为 V2，但新生成的 `public/daily-news.json` 应始终为 V2。删除 `items` 前必须完成独立版本切换和消费者审计。

## 验收

- `GET /api/news` 不调用 `fetch`；
- `GET /api/news` 返回浏览器立即重验证头，Vercel 同一 30 秒窗口出现 MISS→HIT；health、错误和写入口仍为 `no-store`；
- `GET /api/news?view=web&reload=1` 对浏览器返回 `no-store` 且同边缘 5 秒内复用；非法 cache query 在读取 durable storage 前返回 `400 + no-store`；
- 冷启动立即返回非空 V2；
- health 区分 report availability 和 refresh health；
- 未配置/错误 refresh token 的状态码分别为 `503`/`401`；
- cron 未配置/错误 secret 的状态码分别为 `503`/`401`，并发调用最多一个执行采集；
- 质量失败不替换 last-known-good；
- fallback 不改变 `generatedAt` 或 `lastSuccessAt`；
- 两个冷进程读取同一个 `latestReportId`，发布后 60 秒内一致；
- 报告超过 30 分钟时 `/api/news` 与 `/api/health` 均为 `stale`；
- API 失败时浏览器继续静态 fallback。

## 待确认

- 历史日报只读 endpoint；
- `items` 兼容字段删除时间；
- CORS 白名单和只读 endpoint 限流策略；
- 是否公开历史日报 endpoint；
- Supabase Cron/Vault 的运维 owner 和告警渠道；调度实现已固定为每 15 分钟调用受保护 `/api/cron`。
