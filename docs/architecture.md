# Daily News Architecture

Daily News is a Vite + React + TypeScript news-ranking app with a small Node API for live refresh.

## Data Flow

1. `src/config/sources.ts` defines enabled sources, sections, search terms, primary categories, language, region, credibility and paywall hints.
2. `scripts/newsService.ts` loads local environment variables, fetches Firecrawl news/web results through keyless mode, falls back to direct public source page/feed fetching when Firecrawl returns no live items or hits keyless limits, resolves each item's published time from result metadata, article page metadata or URL dates, filters live items outside the default 72-hour freshness window, optionally rewrites non-Chinese title/summary text through a server-side OpenAI-compatible translation endpoint, repairs summaries that are missing or identical to titles, and merges checked-in fallback items for category coverage.
3. `src/lib/dedupe.ts` clusters similar stories by URL and token overlap, then chooses one `primaryCategory` per cluster so category views do not repeat the same story. Source sections provide the initial category, while `scripts/newsService.ts` can correct broad sections using title, summary and URL signals before clustering.
4. `src/lib/scoring.ts` ranks clusters by public importance, user preference, timeliness, source confidence and content quality. `src/lib/trust.ts` independently assigns low/medium/high trust and decides whether a story is too low quality to show.
5. `scripts/newsServer.ts` caches the report in memory and exposes `GET /api/news`.
6. `src/App.tsx` fetches `/api/news`, falls back to `/daily-news.json`, then to the checked-in `firecrawlSnapshotNews`.

## Runtime Shape

- Development frontend: `npm run dev` on `127.0.0.1:5173`.
- Development API: `npm run api` on `127.0.0.1:4173`.
- Production-style local service: `npm run serve`, which builds `dist/` and serves both static files and API.
- Cache storage: in memory only. There is no database.

## API Routes

- `GET /api/news`: returns the current `DailyNewsReport` plus refresh metadata. Each item includes `primaryCategory` and `trust`.
- `POST /api/refresh`: triggers a refresh and returns the new `generatedAt`.
- `GET /api/health`: returns service health, item count and last refresh error.

## Security Boundaries

- Firecrawl runs in keyless mode; the app does not require or read `FIRECRAWL_API_KEY`.
- `DAILY_NEWS_TRANSLATION_API_KEY` is read only by Node scripts and is required only when non-Chinese sources should be rewritten into Chinese or duplicate summaries should be repaired. Translation defaults to DeepSeek Flash; `DAILY_NEWS_TRANSLATION_BASE_URL` and `DAILY_NEWS_TRANSLATION_MODEL` are optional server-only overrides.
- The browser never reads `.env`, `.env.local` or translation credentials.
- Public static fallback data lives in `public/daily-news.json`; it is generated output, not the editing source of truth.
