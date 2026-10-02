# Daily News 重构实施说明

当前分支以固定 AIHOT commit `3343fe2b20db4be7269113752d82d3992fc52b6b` 为底座。已批准计划见 `docs/planning/aihot-v2-refactor-plan.md`；实际阶段证据见 `docs/refactor-runtime.md`。

## 新运行入口

- Node >=24.11；npm workspaces：`apps/*`、`packages/*`、`industry`。
- `apps/web` 只通过 HTTP 访问 API；公开出口只读 `packages/backend/src/publication/`。
- 采集和模型默认关闭，模型及付费采集必须经过预算与回执；不自动启用上游示范来源。
- 只对独立 PostgreSQL 运行 `node scripts/migrate.ts`；禁止把 AIHOT migrations 应用到旧 Supabase。
- 检查：`npm run typecheck`、`npm run build`、`npm run test:web`；隔离 `_test` / `_ci` 库迁移后运行 `npm test`；服务启动后 `node scripts/smoke.ts --base http://127.0.0.1:3300`。
- 前台保持中文、十个唯一主分类；AI 原标准与非 AI 确定性规则不可混成一个评分。
- 保留 MIT/NOTICE 与 `reference/baselines/`。不自动同步上游、不部署生产、不恢复历史观察任务。
- 下方是旧实现说明。`src/`、旧 `scripts/news*.ts`、`api/`、`supabase/` 和 `public/daily-news.json` 暂保留作兼容/迁移基准，不能用旧 npm 命令判断新底座可用。生产旧系统仍以原提交和部署为准。

---

# Daily News Agent Notes

## Project Shape

- This is a Vite + React + TypeScript event-level news briefing.
- The app prefers `GET /api/news`, falls back to `public/daily-news.json`, then falls back to `src/data/firecrawlSnapshot.ts`.
- `scripts/newsRefresh.ts` owns manual/Cron refresh orchestration. Production uses Supabase for leases, source state, candidates, immutable snapshots and the latest pointer; local development without Supabase uses `InMemoryNewsStore`.
- `scripts/newsServer.ts` provides the local API and production-style static server. Firecrawl runs keyless; `DAILY_NEWS_TRANSLATION_*` values remain server-only.
- `scripts/generateDailyNews.ts` writes `public/daily-news.json` through shared logic in `scripts/newsService.ts`.
- `scripts/newsService.ts` runs Firecrawl keyless and direct public source page/feed collection concurrently. Production refreshes never insert fallback content into the live candidate pool.

## Commands

```bash
npm test
npm run test:integration
npm run build
npm run generate
npm run api
npm run dev
npm run serve
npm run monitor:production -- status --output .production-acceptance/current
```

Use `npm test` for core logic changes, `npm run test:integration` for API/store/refresh changes, and `npm run build` for frontend or TypeScript changes.

## Editing Rules

- Keep user-facing page copy, news titles, summaries, and source names in Chinese.
- If external or generated data can contain English source names, preserve the `sourceLabel` fallback in `src/App.tsx`.
- Do not treat `public/daily-news.json` as the source of truth. When changing saved news content or source coverage, update `src/data/firecrawlSnapshot.ts` or `src/config/sources.ts` first, then regenerate the JSON if needed.
- Do not paste Firecrawl keys or `.env.local` values into code, logs, commits, or responses.
- `dist/` is build output. Update it only when a verified build is part of the requested change.
- Keep `/api/news`, `/api/health`, `/api/refresh`, and `/api/cron` server-only; do not move collection or refresh calls into browser code.
- Treat `.production-acceptance/current/summary.json` as historical acceptance progress and verdict, not proof that the observer process is alive or production is healthy. Formal burn-in/soak is canceled; do not resume or splice an old window without explicit approval. Before claiming any monitor is running, run `npm run monitor:production -- status --output .production-acceptance/current`, require `monitorProcess.running: true`, and verify that the deployment alias still matches the active window.
- Category pages filter by `primaryCategory`; auxiliary `categories` are explanatory tags and must not make one story appear in multiple category tabs.
- Source admission is decided when configuring a source. `trust.shouldShow` is compatibility-only and must not filter, tier or rank stories.
- Reuters, Bloomberg, FT, WSJ, and The Athletic are disabled because direct visitor verification is unreliable due to 401/paywall behavior.

## Key Files

- `src/App.tsx` — page layout, category navigation, news rendering, source-name display mapping.
- `src/data/firecrawlSnapshot.ts` — checked-in fallback snapshot used when live fetching is unavailable.
- `src/lib/newsPipeline.ts` — report build pipeline.
- `src/lib/scoring.ts`, `src/lib/trust.ts`, and `src/lib/dedupe.ts` — ranking, trust, clustering and primary-category logic.
- `scripts/newsService.ts` — shared Firecrawl fetch, direct source fetch, translation, fallback merge, and report generation logic.
- `scripts/newsRefresh.ts` — durable lease, source selection, candidate pool, structural invariants and atomic publish orchestration.
- `scripts/supabaseNewsStore.ts` and `scripts/inMemoryNewsStore.ts` — production and local `NewsStore` implementations.
- `scripts/newsServer.ts` — local live API and production-style static server.
- `scripts/productionAcceptanceMonitor.ts` — historical deterministic burn-in/soak monitor and local observer status tool.
- `scripts/generateDailyNews.ts` — report generation entrypoint.
- `supabase/migrations/` — production schema, RLS, RPC, fencing and atomic refresh migrations.
- `docs/architecture.md` and `docs/runbook.md` — current API/data-flow and operations references.
