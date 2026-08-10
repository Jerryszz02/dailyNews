# Daily News Architecture

Daily News is a Vite + React + TypeScript event-level news briefing with a server-only Supabase-backed refresh service.

## Data Flow

1. `src/config/sources.ts` separates collection (`enabled`) from publication admission (`approved`) and records allowed hosts, review notes and publication roles. `src/lib/sourceCoverage.ts` selects at most eleven due sources per five-minute run: nine normal rotation slots and up to two partial/failed retries. Open circuits never suppress the rolling 30-minute attempt invariant.
2. `scripts/newsService.ts` runs Firecrawl keyless web/news search and bounded direct page/feed/sitemap collection concurrently within a 45-second budget. Each source request has an independent timeout, sitemap limits are honored, and both requested and redirect-final URLs must remain inside the source allowlist.
3. Candidate identity and original text survive enrichment independently and are persisted in the same atomic terminal commit. Translation failures keep the original text visible with `translationStatus: pending`; missing summaries and publication times degrade to explicit pending/estimated states instead of deleting the candidate.
4. `src/lib/curation.ts` rejects only unapproved/out-of-domain sources, invalid or missing identity, navigation pages and explicit promotion. Trust and credibility do not affect inclusion, tier or ranking.
5. `src/lib/dedupe.ts` always merges the same canonical URL. Cross-URL items merge only inside the same primary category and 24-hour window when title overlap is at least 0.8 and combined similarity is at least 0.85. Events expose distinct `startedAt` and `updatedAt`.
6. `src/lib/newsPipeline.ts` emits `DailyNewsReport` V2. `stories` contains every valid event; `latestStories` contains every event updated in the last 24 hours, with a 72-hour fallback when that window is quiet. Curated sections are soft reorders and cannot remove events from latest or category pages.
7. `scripts/newsRefresh.ts` acquires a fenced lease, paginates the complete rolling 72-hour candidate pool and validates schema, IDs, admission, URLs, time relationships, evidence references, one-to-one candidate mapping and compact/full round trips. Business selection thresholds are not publication gates.
8. `scripts/supabaseNewsStore.ts` uses the versioned atomic finish RPC to commit source results, candidates, run metrics, an optional immutable snapshot and the latest pointer in one transaction for published, unchanged and partial outcomes. Timeout reconciliation queries by run/idempotency key; the previous RPC remains available for rollback.
9. `GET /api/news` reads publication state independently of source-health RPCs and falls back through older valid snapshots before the bundled report. `src/App.tsx` updates report content and service status independently so an older fallback cannot overwrite a newer report.

## Runtime Shape

- Development frontend: `npm run dev` on `127.0.0.1:5173`.
- Development API: `npm run api` on `127.0.0.1:4173`.
- Production-style local service: `npm run serve`, which builds `dist/` and serves both static files and API.
- Local runtime without Supabase: async in-memory NewsStore with the same lease/candidate/publish contract.
- Production runtime: Supabase stores source state, refresh runs, fenced lease, 72-hour candidates, immutable snapshots and the singleton latest pointer.
- Scheduler: Supabase Cron runs every 5 minutes through `pg_net` and calls authenticated `GET /api/cron`; it does not rely on a Vercel function timer.
- Acceptance observer: `scripts/productionAcceptanceMonitor.ts` is a local read-only LaunchAgent that records the 24-hour burn-in and seven-day soak. It never drives production refreshes, and any deployment alias change invalidates its active window.

## API Routes

- `GET /api/news`: immediately returns the current V2 report plus refresh metadata; it does not fetch external news.
- `POST /api/refresh`: triggers refresh. Vercel requires `DAILY_NEWS_REFRESH_TOKEN`; an unconfigured production endpoint returns `503`.
- `GET /api/cron`: Supabase Cron trigger protected by `CRON_SECRET`; the database lease makes retries and overlap idempotent.
- `GET /api/health`: returns independent `servingMode`, `pipelineStatus` and `contentStatus` axes plus check/sweep/publish/content timestamps. Any valid last-known-good remains HTTP 200; 503 means no report is serviceable.

## Security Boundaries

- Firecrawl runs in keyless mode; the app does not require or read `FIRECRAWL_API_KEY`.
- `DAILY_NEWS_TRANSLATION_API_KEY` is read only by Node scripts and is required only when non-Chinese sources should be rewritten into Chinese or duplicate summaries should be repaired. Translation defaults to DeepSeek Flash; `DAILY_NEWS_TRANSLATION_BASE_URL` and `DAILY_NEWS_TRANSLATION_MODEL` are optional server-only overrides.
- The browser never reads `.env`, `.env.local` or translation credentials.
- `SUPABASE_SECRET_KEY`, `CRON_SECRET` and refresh token are server-only. Internal Supabase tables have RLS enabled and no anon/authenticated policies; RPC execute is restricted to the service role.
- Public static fallback data lives in `public/daily-news.json`; it is generated output, not the editing source of truth.
