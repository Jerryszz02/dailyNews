# 旧版新闻接口过渡边界

重构后的公开接口使用 `/api/v1/*`。旧版 `/api/news` 返回 `DailyNewsReport` V2（包括旧版 trust、importance、quality、排名等），这些字段不能从新系统的事实、分析及发布结果无损重建。因此新 API 仅在运维显式设置 `LEGACY_NEWS_BASE_URL` 时，把合法的旧版 GET 请求原样转发至仍在运行的旧服务；它不把新系统分数伪装成 V2。配置值必须是无凭据、无路径、无查询的 HTTPS origin，例如 `https://legacy.example`。

旧版 `/api/news` 仅接受无参数、`view=web`、`view=web&reload=1`，重复或未知参数返回 400。代理只向固定 origin 的 `/api/news` 发 GET，不转发浏览器凭据，不跟随重定向，并限制 5 秒和 8 MiB。旧服务的成功响应和有效 4xx（包括 429）保留原始 JSON、状态及相关缓存/重试头；未配置、上游 5xx 或不可用统一返回 `503`、`Cache-Control: no-store`，并指向新 `/api/v1/items` 与历史归档。旧服务本身可能以 `refresh.servingMode=bundled` 返回其 fallback，因此代理响应只表示“旧服务实际响应”，不能一概称为实时或持久发布。新服务不会拿冻结快照填补此接口。

旧版 `POST /api/refresh` 和 `GET /api/cron` 以及同路径的其他方法均返回 `410`，不会转接新 worker 或管理 API。新 `/api/health` 是新系统的健康状态，不是旧服务健康状态。

`/api/legacy/archive` 单独提供仓库中冻结的 `public/daily-news.json` 历史 fallback 元数据；`/api/legacy/archive/report` 提供原始 JSON 字节。读取前校验 `reference/baselines/daily-news-v1.json` 中的 SHA-256 与文件本身，固定值为 `38cbdbbd00865a735ba01095d26a1bdfccdcea959dd5fbbd4c2c8f1e40af9f36`，原始生成时间为 `2026-07-09T15:39:06.365Z`。该文件有 47 个事件、47 个条目，**不是完整旧库或实时新闻**。

`/api/legacy/archive/stories/:id` 只按原始 `event-*` ID 返回实际存档的事件及其原始条目；`/api/legacy/archive/candidates/:id` 只按原始候选 ID 返回实际存档的条目和证据引用。未收录的 ID 返回 404，不推断它对应哪个新系统故事，也不做模糊重定向。冻结快照没有日报版次，`/api/legacy/archive/dailies/:id` 返回 404。旧系统其他历史数据、生产 Supabase 记录与外部消费者仍待独立盘点和导出；本过渡接口不声称完成这些迁移。
