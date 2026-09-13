# Daily News Architecture

Daily News is a Vite + React + TypeScript event-level news briefing with a server-only Supabase-backed refresh service.

## Data Flow

1. `src/config/sources.ts` separates collection (`enabled`) from publication admission (`approved`) and records allowed hosts, review notes, publication roles and signal roles. Every two-hour production refresh plans all enabled and approved sources; persistent due/health state remains diagnostic rather than suppressing discovery.
2. `scripts/newsService.ts` runs one continuously replenished pool of up to 50 source tasks within a 240-second collection budget. Each task prefers its configured RSS/Atom feed, falls back to its public page, and uses Firecrawl keyless only when direct collection has no usable recent candidates. Feed endpoints have explicit host scope separate from article admission; redirects and candidate URLs remain checked. Network/provider work and source attempts have independent bounds.
   `scripts/xSource.ts` reads official X user timelines with a server-only bearer token. User IDs, incremental IDs and incomplete pagination state are persisted with source results and candidates in the same fenced transaction. No token means X is excluded from the active registry; configured website collection continues. Replies and retweets are excluded. X, Firecrawl and translation each use a four-request provider gate within the source pool.
3. Candidate identity and original text survive enrichment independently and are persisted in the same atomic terminal commit. Translation failures keep the original text visible with `translationStatus: pending`; missing summaries and publication times degrade to explicit pending/estimated states instead of deleting the candidate.
4. `src/lib/curation.ts` rejects only unapproved/out-of-domain sources, invalid or missing identity, navigation pages and explicit promotion. `trust.shouldShow` does not affect inclusion, tier or ranking; `trust.level` can establish a confirmed fact status, and confirmed stories are excluded from the watchlist layer while remaining available in stories, latest and category views.
5. `src/lib/dedupe.ts` always merges the same canonical URL. Cross-URL items merge locally only inside the same primary category and 24-hour window when title overlap is at least 0.8 and combined similarity is at least 0.85. When explicitly enabled, `scripts/semanticDedupe.ts` sends only ambiguous new pairs to a capped LLM pass and persists high-confidence same-event anchors in candidate JSON.

Recollecting a candidate with changed title, summary, publication time or primary category clears both stored semantic fields before any optional model decision. Daily editions persist their own frozen `stories` projection, so later live-card changes or removal from the rolling pool do not alter a published edition.
6. `src/lib/newsPipeline.ts` emits `DailyNewsReport` V2. `stories` contains every valid event; `latestStories` contains every event updated in the last 24 hours, with a 72-hour fallback when that window is quiet. The report also carries explainable selection metadata, a 48-hour heat projection and a Shanghai 08:00 daily edition across the configured beats.
7. `scripts/newsRefresh.ts` acquires a fenced lease, paginates the complete rolling 72-hour candidate pool and validates schema, IDs, admission, URLs, time relationships, evidence references, one-to-one candidate mapping and compact/full round trips. Once a non-empty daily edition is published, later refreshes with the same edition ID preserve it. Business selection thresholds are not publication gates.
8. `scripts/supabaseNewsStore.ts` uses the versioned atomic finish RPC to commit source results, candidates, run metrics, an optional immutable snapshot and the latest pointer in one transaction for published, unchanged and partial outcomes. Timeout reconciliation queries by run/idempotency key; the previous RPC remains available for rollback.
9. `GET /api/news` reads publication state independently of source-health RPCs and falls back through older valid snapshots before the bundled report. `src/App.tsx` updates report content and service status independently so an older fallback cannot overwrite a newer report.

## Runtime Shape

- Development frontend: `npm run dev` on `127.0.0.1:5173`.
- Development API: `npm run api` on `127.0.0.1:4173`.
- Production-style local service: `npm run serve`, which builds `dist/` and serves both static files and API.
- Local runtime without Supabase: async in-memory NewsStore with the same lease/candidate/publish contract.
- Production runtime: Supabase stores source state and X cursors, refresh runs, fenced lease, 72-hour candidates, immutable snapshots and the singleton latest pointer. Cron/refresh Vercel functions have a 300-second limit; the 120-second lease is renewed while work continues. A lost lease prevents terminal commits.
- Scheduler: Supabase Cron runs every 2 hours through `pg_net` and calls authenticated `GET /api/cron`; it does not rely on a Vercel function timer.
- Historical acceptance observer: `scripts/productionAcceptanceMonitor.ts` is a local read-only LaunchAgent that is currently stopped. It never drives production refreshes; formal burn-in/soak is canceled, and any future explicitly approved run must invalidate its active window when the deployment alias changes.

## API Routes

- `GET /api/news`: immediately returns the current V2 report plus refresh metadata, including optional `hotStories` and `dailyEdition`; it does not fetch external news.
- `POST /api/refresh`: triggers refresh. Vercel requires `DAILY_NEWS_REFRESH_TOKEN`; an unconfigured production endpoint returns `503`.
- `GET /api/cron`: Supabase Cron trigger protected by `CRON_SECRET`; the database lease makes retries and overlap idempotent.
- `GET /api/health`: returns independent `servingMode`, `pipelineStatus` and `contentStatus` axes plus check/sweep/publish/content timestamps. Any valid last-known-good remains HTTP 200; 503 means no report is serviceable.

## Security Boundaries

- Firecrawl runs in keyless mode; the app does not require or read `FIRECRAWL_API_KEY`.
- `DAILY_NEWS_TRANSLATION_API_KEY` is read only by Node scripts and is required only when non-Chinese sources should be rewritten into Chinese or duplicate summaries should be repaired. Translation defaults to DeepSeek Flash; `DAILY_NEWS_TRANSLATION_BASE_URL` and `DAILY_NEWS_TRANSLATION_MODEL` are optional server-only overrides.
- Semantic dedupe is disabled unless `DAILY_NEWS_LLM_DEDUPE_ENABLED=true`; it reuses the server-only translation provider and defaults to twelve model calls per refresh.
- The browser never reads `.env`, `.env.local` or translation credentials.
- `SUPABASE_SECRET_KEY`, `CRON_SECRET` and refresh token are server-only. Internal Supabase tables have RLS enabled and no anon/authenticated policies; RPC execute is restricted to the service role.
- Public static fallback data lives in `public/daily-news.json`; it is generated output, not the editing source of truth.
