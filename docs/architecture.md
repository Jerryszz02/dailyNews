# Daily News Architecture

Daily News is a Vite + React + TypeScript event-level news briefing with a server-only Supabase-backed refresh service.

## Data Flow

1. `src/config/sources.ts` defines enabled sources and sections. `src/lib/sourceCoverage.ts` first selects sources whose persistent `nextDueAt` has arrived, then balances beat gaps, source type, region, credibility and circuit state. Under healthy conditions, ten sources per 15-minute run cover all 49 enabled sources within a rolling 90-minute window; circuit-open sources re-enter after their cooldown.
2. `scripts/newsService.ts` gives Firecrawl keyless about the first 4 seconds and at most 8 seconds, then uses bounded-concurrency direct page/feed fetches. The collection phase has a 12-second default deadline so persistent read retries and atomic publication retain margin inside the 30-second refresh target; it emits live candidates plus per-source outcomes and does not insert fallback content into the production candidate path.
3. `src/lib/curation.ts` rejects missing identity/time, generic summaries and promotion; `src/lib/dedupe.ts` groups URL matches, rewritten titles and same-window shared-context updates into one event.
4. Every event receives evidence entries, an independence group, fact status, event type, public-impact features and one tier: `must_know`, `important`, `special_interest` or `noise`. Personal preference cannot promote a story into `must_know`.
5. `src/lib/newsPipeline.ts` emits `DailyNewsReport` V2 with canonical `stories`, homepage subsets, beat sections, public coverage/quality summaries and the legacy `items` projection.
6. `scripts/newsRefresh.ts` acquires a fenced Supabase lease, reads the rolling 72-hour pool, applies absolute/relative quality gates and publishes only content changes. For a changed, publishable Supabase refresh, source outcomes, newly collected candidates and publication are committed together; rejected or unchanged runs persist collection results before recording their final status. Quiet success updates durable check time without changing `reportId/generatedAt`.
7. `scripts/supabaseNewsStore.ts` accesses private tables only through service-role RPC. The repository migration `20260723093000_atomic_refresh_commit.sql` makes the successful changed-report path one transaction covering source outcomes, candidate upserts, snapshot insert, run completion and latest pointer switch; stale workers cannot publish with an old fencing token.
8. `GET /api/news` reads the durable latest report and never fetches sources. If Supabase is unavailable it returns the bundled last-known-good with stale/degraded metadata.
9. `src/App.tsx` renders event-level briefing sections and distinct report/content/check times, falling back from `/api/news` to `/daily-news.json` and then a snapshot whose original time is preserved.

## Runtime Shape

- Development frontend: `npm run dev` on `127.0.0.1:5173`.
- Development API: `npm run api` on `127.0.0.1:4173`.
- Production-style local service: `npm run serve`, which builds `dist/` and serves both static files and API.
- Local runtime without Supabase: async in-memory NewsStore with the same lease/candidate/publish contract.
- Production runtime: Supabase stores source state, refresh runs, fenced lease, 72-hour candidates, immutable snapshots and the singleton latest pointer.
- Scheduler: Supabase Cron runs every 15 minutes through `pg_net` and calls authenticated `GET /api/cron`; it does not rely on a Vercel function timer.

## API Routes

- `GET /api/news`: immediately returns the current V2 report plus refresh metadata; it does not fetch external news.
- `POST /api/refresh`: triggers refresh. Vercel requires `DAILY_NEWS_REFRESH_TOKEN`; an unconfigured production endpoint returns `503`.
- `GET /api/cron`: Supabase Cron trigger protected by `CRON_SECRET`; the database lease makes retries and overlap idempotent.
- `GET /api/health`: separates report availability from durable refresh health; stale/unavailable returns `503` while `/api/news` can still return last-known-good.

## Security Boundaries

- Firecrawl runs in keyless mode; the app does not require or read `FIRECRAWL_API_KEY`.
- `DAILY_NEWS_TRANSLATION_API_KEY` is read only by Node scripts and is required only when non-Chinese sources should be rewritten into Chinese or duplicate summaries should be repaired. Translation defaults to DeepSeek Flash; `DAILY_NEWS_TRANSLATION_BASE_URL` and `DAILY_NEWS_TRANSLATION_MODEL` are optional server-only overrides.
- The browser never reads `.env`, `.env.local` or translation credentials.
- `SUPABASE_SECRET_KEY`, `CRON_SECRET` and refresh token are server-only. Internal Supabase tables have RLS enabled and no anon/authenticated policies; RPC execute is restricted to the service role.
- Public static fallback data lives in `public/daily-news.json`; it is generated output, not the editing source of truth.
