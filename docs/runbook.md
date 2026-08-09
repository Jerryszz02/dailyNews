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
DAILY_NEWS_REFRESH_INTERVAL_MINUTES=5
DAILY_NEWS_COLLECTION_BUDGET_MS=45000
DAILY_NEWS_SOURCE_CONCURRENCY=11
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

Production defaults to eleven due sources per run: nine normal rotation slots and up to two priority retries for partial/failed sources. Persistent `next_due_at` rotation covers every enabled and approved source with at least one attempt in each rolling 30-minute window; an open circuit does not suppress that coverage attempt.

`DAILY_NEWS_COLLECTION_BUDGET_MS` is the hard wall-clock deadline for one collection round. Production defaults to 45 seconds inside the 60-second function limit, leaving about 10 seconds for candidate paging, report construction and atomic commit. Firecrawl and direct source work run concurrently; each request is independently bounded to eight seconds. Sources that have not started before the deadline remain due for the next slot instead of being recorded as healthy empty.

Set `DAILY_NEWS_REFRESH_TOKEN` on Vercel before enabling `POST /api/refresh`. Send it as `Authorization: Bearer <token>`. Do not put the token in browser code.

Set `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `CRON_SECRET` only in server-side environments. Never add `VITE_` to those names. Supabase Cron reads the production `/api/cron` URL and the same cron secret from Vault; migration files contain only the Vault secret names.

`DAILY_NEWS_TRANSLATION_API_KEY` is optional and server-only. When set, the generator defaults to DeepSeek Flash (`https://api.deepseek.com` and `deepseek-v4-flash`) to rewrite non-Chinese stories into Chinese titles and summaries, and to repair summaries that are missing or identical to titles. Set `DAILY_NEWS_TRANSLATION_BASE_URL` or `DAILY_NEWS_TRANSLATION_MODEL` only when overriding those defaults. On Vercel, configure the API key as a project environment variable, not in committed files.

## Smoke Checks

```bash
curl http://127.0.0.1:4173/api/health
curl http://127.0.0.1:4173/api/news
```

Expected behavior:

- `/api/health` and `/api/news` return 200 whenever a structurally valid last-known-good exists, even when `pipelineStatus=degraded` or `contentStatus=stale`; 503 means no report is serviceable.
- `/api/news` returns `version: 2`, non-empty `stories`, derived-or-stored `latestStories` and legacy `items` without waiting for external fetching.
- Refresh metadata includes `servingMode`, `pipelineStatus`, `contentStatus`, `lastCheckedAt`, `lastFullSweepAt`, `lastPublishedAt` and `newestContentAt`.
- Ordinary `/api/news?view=web` reads use a 30-second shared cache. Manual `/api/news?view=web&reload=1` reads are `no-store`; clients do not send clock-derived cache-window parameters.
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
- If candidate paging or report validation fails, the refresh keeps last-known-good. Source count, beat continuity, trust and curated selection are not publication gates; a valid visible change from the complete candidate window should publish.
- If NBA, FIFA, FIBA or AI company blog items are missing, check whether `DAILY_NEWS_TRANSLATION_API_KEY` is configured; many of those sources return English-only title and summary text.
- Preferences only reorder important/category stories; they never hide or promote `must_know` events.
- Refresh is polling-based: Supabase Cron checks every 5 minutes and the frontend reloads the published report every 30 seconds. The app does not receive source-side webhooks.
- If `/api/news` is readable but `/api/health` is stale, check Supabase `refresh_run`, `runtime_state`, source due-state, Cron/Vault configuration and Vercel `/api/cron` logs in that order.

## Token-free production acceptance monitor

Use the deterministic local monitor instead of an AI heartbeat for the 24-hour burn-in and seven-day soak. It audits each burn-in slot at the 5-minute boundary plus 75 seconds, writes secret-free JSONL evidence immediately, retries a transient exit from the read-only Vercel setup commands once before treating the observer as failed, automatically starts a fresh candidate window after a failed slot, and changes to one rolling 24-hour check per day after all 288 strict burn-in slots pass. Each audit requires all enabled/approved sources to have an attempt within 30 minutes, `unmappedCandidateCount=0` and 100% recall from valid recent events into `latestStories`.

```bash
npm run monitor:production -- start \
  --deployment dpl_PUBLIC_DEPLOYMENT_ID \
  --output .production-acceptance/current \
  --first-slot next \
  --keep-awake

npm run monitor:production -- status --output .production-acceptance/current
npm run monitor:production -- stop --output .production-acceptance/current
```

The output directory is gitignored. `evidence.jsonl` is append-only; `state.json` and `summary.json` are atomically replaced after every audit; `final-report.json` appears only after the burn-in and all seven soak days pass. The production environment is pulled only into a random mode-600 file, the database transaction is read-only and rolled back, and the temporary PostgreSQL client is deleted when the monitor exits. Evidence contains public deployment/run/report IDs and non-sensitive aggregates only.

`start` installs a minimal-environment plist under `~/Library/LaunchAgents`, so the saved monitor resumes after a login or reboot. LaunchAgent stdout and stderr stay outside Desktop TCC scope under `~/Library/Logs/dailyNews-production-acceptance`; the directory is mode 700 and both log files are mode 600. An unexpected non-zero exit is restarted after a short throttle, while a normal completion or explicit `stop` is not restarted. `--keep-awake` prevents idle system sleep while the monitor runs, but it cannot make a closed laptop lid execute code. A missed slot is recorded as a real failed attempt and is never reconstructed from later data. Restart the same command with the same output directory to resume from its saved state.
