# Daily News Agent Notes

## Project Shape

- This is a Vite + React + TypeScript news-ranking prototype.
- The app prefers `GET /api/news`, falls back to `public/daily-news.json`, then falls back to `src/data/sampleNews.ts`.
- `scripts/newsServer.ts` provides the local API and in-memory refresh cache. It must be the only runtime path that reads `FIRECRAWL_API_KEY` for live browser use.
- `scripts/generateDailyNews.ts` writes `public/daily-news.json` through shared logic in `scripts/newsService.ts`.

## Commands

```bash
npm test
npm run build
npm run generate
npm run api
npm run dev
npm run serve
```

Use `npm test` for scoring/dedupe logic changes and `npm run build` for frontend or TypeScript changes.

## Editing Rules

- Keep user-facing page copy, news titles, summaries, and source names in Chinese.
- If external or generated data can contain English source names, preserve the `sourceLabel` fallback in `src/App.tsx`.
- Do not treat `public/daily-news.json` as the source of truth. When changing saved news content, update `src/data/firecrawlSnapshot.ts` or `src/data/sampleNews.ts` first, then regenerate the JSON if needed.
- Do not paste Firecrawl keys or `.env.local` values into code, logs, commits, or responses.
- `dist/` is build output. Update it only when a verified build is part of the requested change.
- Keep `/api/news`, `/api/health`, and `/api/refresh` server-only; do not move Firecrawl calls into browser code.

## Key Files

- `src/App.tsx` — page layout, category navigation, news rendering, source-name display mapping.
- `src/data/firecrawlSnapshot.ts` — checked-in fallback snapshot used when Firecrawl is not configured.
- `src/data/sampleNews.ts` — in-app fallback data before `public/daily-news.json` loads.
- `src/lib/newsPipeline.ts` — report build pipeline.
- `src/lib/scoring.ts` and `src/lib/dedupe.ts` — ranking and clustering logic.
- `scripts/newsService.ts` — shared Firecrawl fetch, fallback merge, and report generation logic.
- `scripts/newsServer.ts` — local live API and production-style static server.
- `scripts/generateDailyNews.ts` — report generation entrypoint.
- `docs/architecture.md` and `docs/runbook.md` — current API/data-flow and operations references.
