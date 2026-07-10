# Daily News API 设计

## 当前边界

API 只负责读取或刷新已经生成的事件级报告。外部来源抓取不能发生在 `GET /api/news` 请求路径中。当前实现位于 `scripts/newsApi.ts`、`scripts/newsServer.ts` 和三个 `api/*.ts` Vercel 入口。

## Endpoint

| Endpoint | Method | 作用 | 成功状态 |
| --- | --- | --- | --- |
| `/api/news` | `GET` | 立即返回 last-known-good V2 报告 | `200` |
| `/api/health` | `GET` | 报告可用性和最近刷新状态 | `200`；没有任何报告时 `503` |
| `/api/refresh` | `POST` | 运行一次受保护刷新，质量达标后切换 latest | `200` |

其他 `/api/*` 路径在本地 Node 服务中返回 `404` JSON。

## 通用规则

- 响应为 UTF-8 JSON。
- 当前 CORS 为 `Access-Control-Allow-Origin: *`。
- Serverless 只读响应使用 `s-maxage=60, stale-while-revalidate=300`；本地 Node 服务使用 `no-store`。
- 公开错误只返回归一化信息，不返回外部响应正文、secret 或 translation 配置。

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
    intervalMinutes: number;
    status?: "healthy" | "degraded";
    lastError: string | null;
  };
}
```

契约：

- `stories` 是规范事件集合；
- 三个首页数组互不重复，且成员也来自同一事件模型；
- 每个 `sections.storyIds` 必须能在 `stories` 中解析；
- `items` 是迁移期 V1 兼容投影；
- `coverage` 和 `quality` 只包含可公开聚合，不包含内部抓取错误或凭据。

若没有任何 bundled、memory 或 snapshot 报告，返回 `503`。正常部署和本地启动会先加载 bundled last-known-good，因此不需要等待首次外部刷新。

## `GET /api/health`

```ts
{
  ok: boolean;
  reportAvailable: boolean;
  refreshStatus: "healthy" | "degraded";
  generatedAt: string | null;
  itemCount: number;
}
```

本地响应还可包含非敏感 `lastError`；刷新失败不会使已有报告变成不可读。

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

## 前端兼容

加载顺序固定为：

1. `/api/news`；
2. `/daily-news.json`；
3. `firecrawlSnapshotNews`。

前端可读取 V1 静态 `items` 并在内存升级为 V2，但新生成的 `public/daily-news.json` 应始终为 V2。删除 `items` 前必须完成独立版本切换和消费者审计。

## 验收

- `GET /api/news` 不调用 `fetch`；
- 冷启动立即返回非空 V2；
- health 区分 report availability 和 refresh health；
- 未配置/错误 refresh token 的状态码分别为 `503`/`401`；
- 质量失败不替换 last-known-good；
- API 失败时浏览器继续静态 fallback。

## 待确认

- 历史日报只读 endpoint；
- `items` 兼容字段删除时间；
- 生产调度器、CORS 白名单和限流策略；
- 外部持久化供应商与跨实例 latest pointer。
