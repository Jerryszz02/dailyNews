# Daily News Architecture

Daily News is a Vite + React + TypeScript event-level news briefing with a small Node refresh service.

## Data Flow

1. `src/config/sources.ts` defines enabled sources and sections. `src/lib/sourceCoverage.ts` selects by uncovered primary beat, source role, credibility, collection language cost and optional health/circuit state; auxiliary tags do not count as primary coverage.
2. `scripts/newsService.ts` supports optional Firecrawl keyless plus bounded-concurrency direct page/feed fetches. Local scheduled refresh defaults to all enabled sources and may use both paths. Serverless refresh, static generation and quantitative verification use 10 coverage-aware sources, at most 3 candidates per section, direct fetch only and a 72-hour freshness window; this fixed profile must stay within 20 source-discovery requests.
3. Collection keeps original-language candidates first. URL/time/promotion checks and same-language event clustering run before translation; at most 15 unique English events are translated, and Chinese article enrichment is limited to one candidate per primary beat.
4. `src/lib/curation.ts` rejects missing identity/time, generic summaries and promotion; `src/lib/dedupe.ts` groups URL matches, rewritten titles and same-window shared-context updates into one event while excluding conservative template text from similarity scoring.
5. Trusted clusters receive one coverage-aware primary beat through a one-event/one-beat matching step. Every beat gets a qualified event when candidates exist; `noise` coverage-floor events stay out of the core briefing.
6. Every event receives evidence entries, an independence group, fact status, event type, public-impact features and one tier: `must_know`, `important`, `special_interest` or `noise`. Personal preference cannot promote a story into `must_know`.
7. `src/lib/newsPipeline.ts` emits `DailyNewsReport` V2 with canonical `stories`, homepage subsets, time-descending beat sections, public coverage/quality summaries and the legacy `items` projection.
8. `scripts/reportStore.ts` loads the bundled report at process start, upgrades V1 when needed and applies absolute plus previous-report-aware publish checks. Fixed generation and Serverless refresh additionally run `src/lib/reportAcceptance.ts` before publishing. `GET /api/news` only reads the last-known-good report; refresh runs outside the read path.
9. `src/App.tsx` renders event-level briefing sections and category references, falling back from `/api/news` to `/daily-news.json` and then `firecrawlSnapshotNews`.

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

- When enabled by a caller, Firecrawl runs keyless; the app does not require or read `FIRECRAWL_API_KEY`. Fixed generation and Serverless refresh keep it disabled.
- `DAILY_NEWS_TRANSLATION_API_KEY` is read only by Node scripts and is required only for shortlisted non-Chinese events. Translation defaults to DeepSeek Flash; `DAILY_NEWS_TRANSLATION_BASE_URL` and `DAILY_NEWS_TRANSLATION_MODEL` are optional server-only overrides.
- The browser never reads `.env`, `.env.local` or translation credentials.
- Public static fallback data lives in `public/daily-news.json`; it is generated output, not the editing source of truth.
