# Daily News Architecture

Daily News is a Vite + React + TypeScript event-level news briefing with a small Node refresh service.

## Data Flow

1. `src/config/sources.ts` defines enabled sources and sections. `src/lib/sourceCoverage.ts` selects a bounded set by beat gaps, source type, region, credibility and optional health/circuit state; a beat with only one selected source remains rewarded until it gains a second entry.
2. `scripts/newsService.ts` gives Firecrawl keyless at most 8 seconds, then uses bounded-concurrency direct page/feed fetches. The whole round has a 30-second default deadline and a 72-hour freshness window. Insufficient live candidates fall back to the last generated report.
3. `src/lib/curation.ts` rejects missing identity/time, generic summaries and promotion; `src/lib/dedupe.ts` groups URL matches, rewritten titles and same-window shared-context updates into one event.
4. Every event receives evidence entries, an independence group, fact status, event type, public-impact features and one tier: `must_know`, `important`, `special_interest` or `noise`. Personal preference cannot promote a story into `must_know`.
5. `src/lib/newsPipeline.ts` emits `DailyNewsReport` V2 with canonical `stories`, homepage subsets, beat sections, public coverage/quality summaries and the legacy `items` projection.
6. `scripts/reportStore.ts` loads the bundled report at process start, upgrades V1 when needed and rejects absolute or relative quality regressions. `GET /api/news` only reads this last-known-good report; refresh runs outside the read path.
7. `src/App.tsx` renders event-level briefing sections and category references, falling back from `/api/news` to `/daily-news.json` and then `firecrawlSnapshotNews`.

## Runtime Shape

- Development frontend: `npm run dev` on `127.0.0.1:5173`.
- Development API: `npm run api` on `127.0.0.1:4173`.
- Production-style local service: `npm run serve`, which builds `dist/` and serves both static files and API.
- Runtime report storage: bundled immutable JSON plus an in-memory latest pointer. There is no external production database or historical report service yet.

## API Routes

- `GET /api/news`: immediately returns the current V2 report plus refresh metadata; it does not fetch external news.
- `POST /api/refresh`: triggers refresh. Vercel requires `DAILY_NEWS_REFRESH_TOKEN`; an unconfigured production endpoint returns `503`.
- `GET /api/health`: separates report availability from recent refresh health.

## Security Boundaries

- Firecrawl runs in keyless mode; the app does not require or read `FIRECRAWL_API_KEY`.
- `DAILY_NEWS_TRANSLATION_API_KEY` is read only by Node scripts and is required only when non-Chinese sources should be rewritten into Chinese or duplicate summaries should be repaired. Translation defaults to DeepSeek Flash; `DAILY_NEWS_TRANSLATION_BASE_URL` and `DAILY_NEWS_TRANSLATION_MODEL` are optional server-only overrides.
- The browser never reads `.env`, `.env.local` or translation credentials.
- Public static fallback data lives in `public/daily-news.json`; it is generated output, not the editing source of truth.
