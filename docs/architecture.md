# Daily News Architecture

Daily News is a Vite + React + TypeScript news-ranking app with a small Node API for live refresh.

## Data Flow

1. `src/config/sources.ts` defines enabled sources, sections, categories, language, region, credibility and paywall hints.
2. `scripts/newsService.ts` loads local environment variables, fetches Firecrawl news results when `FIRECRAWL_API_KEY` is set, and merges checked-in fallback items for category coverage.
3. `src/lib/dedupe.ts` clusters similar stories by URL and token overlap.
4. `src/lib/scoring.ts` ranks clusters by public importance, user preference, timeliness, source confidence and content quality.
5. `scripts/newsServer.ts` caches the report in memory and exposes `GET /api/news`.
6. `src/App.tsx` fetches `/api/news`, falls back to `/daily-news.json`, then to `sampleNews`.

## Runtime Shape

- Development frontend: `npm run dev` on `127.0.0.1:5173`.
- Development API: `npm run api` on `127.0.0.1:4173`.
- Production-style local service: `npm run serve`, which builds `dist/` and serves both static files and API.
- Cache storage: in memory only. There is no database.

## API Routes

- `GET /api/news`: returns the current `DailyNewsReport` plus refresh metadata.
- `POST /api/refresh`: triggers a refresh and returns the new `generatedAt`.
- `GET /api/health`: returns service health, item count and last refresh error.

## Security Boundaries

- `FIRECRAWL_API_KEY` is read only by Node scripts and `scripts/newsServer.ts`.
- The browser never reads `.env`, `.env.local` or Firecrawl credentials.
- Public static fallback data lives in `public/daily-news.json`; it is generated output, not the editing source of truth.
