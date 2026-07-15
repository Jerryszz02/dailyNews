# Daily News Runbook

## Commands

```bash
npm install
npm run api
npm run dev
```

Open `http://127.0.0.1:5173/`.

Production-style local run:

```bash
npm run serve
```

Regenerate the static fallback:

```bash
npm run generate
```

Offline V1-to-V2 report upgrade:

```bash
npm run upgrade-report
```

Verify:

```bash
npm test
npm run test:integration
npm run build
```

Supabase schema verification requires Docker locally or a linked staging project:

```bash
npx supabase db reset
npm run test:db
npx supabase db push --dry-run
```

## Environment Variables

```bash
DAILY_NEWS_MAX_SOURCES=11
DAILY_NEWS_LIMIT_PER_SECTION=5
DAILY_NEWS_REFRESH_INTERVAL_MINUTES=15
DAILY_NEWS_COLLECTION_BUDGET_MS=16000
DAILY_NEWS_SOURCE_CONCURRENCY=8
DAILY_NEWS_MAX_AGE_HOURS=72
SUPABASE_URL=
SUPABASE_SECRET_KEY=
CRON_SECRET=
DAILY_NEWS_REFRESH_TOKEN=
DAILY_NEWS_TRANSLATION_API_KEY=YOUR-DEEPSEEK-API-KEY
DAILY_NEWS_TRANSLATION_BASE_URL=
DAILY_NEWS_TRANSLATION_MODEL=
PORT=4173
```

Keep `.env` and `.env.local` local. Do not commit or paste their values.

Production defaults to eleven due sources per run: the normal ten-source cohort plus one recovery slot for a circuit that becomes half-open. Persistent `next_due_at` rotation covers all healthy, enabled sources within 90 minutes at the 15-minute cadence. A source opened by the three-failure circuit breaker is excluded from that window and retried after the configured two-interval cooldown.

`DAILY_NEWS_COLLECTION_BUDGET_MS` is the hard wall-clock deadline for one collection round. Production defaults to 16 seconds so cold start, persistence and publication retain margin inside the 30-second refresh target. With that default, Firecrawl gets about the first 5.3 seconds and never more than 8 seconds; direct source work uses bounded concurrency from `DAILY_NEWS_SOURCE_CONCURRENCY`. Sources that have not started before the deadline remain due for the next slot instead of being recorded as failed.

Set `DAILY_NEWS_REFRESH_TOKEN` on Vercel before enabling `POST /api/refresh`. Send it as `Authorization: Bearer <token>`. Do not put the token in browser code.

Set `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `CRON_SECRET` only in server-side environments. Never add `VITE_` to those names. Supabase Cron reads the production `/api/cron` URL and the same cron secret from Vault; migration files contain only the Vault secret names.

`DAILY_NEWS_TRANSLATION_API_KEY` is optional and server-only. When set, the generator defaults to DeepSeek Flash (`https://api.deepseek.com` and `deepseek-v4-flash`) to rewrite non-Chinese stories into Chinese titles and summaries, and to repair summaries that are missing or identical to titles. Set `DAILY_NEWS_TRANSLATION_BASE_URL` or `DAILY_NEWS_TRANSLATION_MODEL` only when overriding those defaults. On Vercel, configure the API key as a project environment variable, not in committed files.

## Smoke Checks

```bash
curl http://127.0.0.1:4173/api/health
curl http://127.0.0.1:4173/api/news
```

Expected behavior:

- `/api/health` returns `ok: true` only for a fresh durable check. A bundled report may remain readable while health returns `503` + `stale`.
- `/api/news` returns `version: 2`, non-empty `stories` and legacy `items` without waiting for external fetching.
- `/api/news.refresh` includes `reportId`, `dataAsOf`, `newestContentAt`, `lastAttemptAt`, `lastSuccessAt` and `status`.
- Production `/api/news` keeps the default full response compatible. The frontend polls the compact `/api/news?view=web&window=<current-30-second-bucket>` every 30 seconds. Shared reads use a 30-second Vercel CDN TTL; `/api/news?view=web&reload=1` is browser `no-store` with a 5-second edge TTL to limit direct Supabase reads. Invalid cache queries return `400 + no-store`. Health, errors and protected endpoints remain `no-store`.
- The frontend shows 今日必知、重要进展、持续关注、分类深读、搜索和偏好设置。

## Supabase Release

1. Link staging/production and run `db push --dry-run` before `db push`.
2. Configure the two Supabase runtime variables in Vercel.
3. Run `npm run bootstrap:supabase`; it skips if a latest report already exists and preserves the bundled timestamp.
4. Configure `daily_news_refresh_url` and `daily_news_cron_secret` in Supabase Vault.
5. Call `public.daily_news_install_refresh_cron()` with the service role, then verify `cron.job` and refresh runs.
6. Keep the cron disabled until deterministic migration, security, manual two-run, cold-instance, stale, rollback and API/UI smoke checks pass. During a controlled canary, record every pg_net response and durable run; disable again on any hard-gate failure.

## Troubleshooting

- If live API is down, the frontend should fall back to `public/daily-news.json`.
- If Firecrawl returns no fresh results, `scripts/newsService.ts` switches to direct public source page/feed fetching so enabled sources can still refresh from their own pages.
- If neither Firecrawl nor direct fetching returns fresh results, the service keeps the previous report identity/time. It must not republish fallback as current.
- If a refresh loses all candidates for a previously covered core beat or materially collapses event/source counts, the publish gate keeps the previous report.
- If NBA, FIFA, FIBA or AI company blog items are missing, check whether `DAILY_NEWS_TRANSLATION_API_KEY` is configured; many of those sources return English-only title and summary text.
- Preferences only reorder important/category stories; they never hide or promote `must_know` events.
- Refresh is polling-based: Supabase Cron checks every 15 minutes and the frontend reloads the published report every 30 seconds through the shared window URL. The app does not receive source-side webhooks.
- If `/api/news` is readable but `/api/health` is stale, check Supabase `refresh_run`, `runtime_state`, source due-state, Cron/Vault configuration and Vercel `/api/cron` logs in that order.
