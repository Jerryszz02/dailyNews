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

Verify:

```bash
npm test
npm run build
```

## Environment Variables

```bash
DAILY_NEWS_MAX_SOURCES=
DAILY_NEWS_LIMIT_PER_SECTION=5
DAILY_NEWS_REFRESH_INTERVAL_MINUTES=15
DAILY_NEWS_TRANSLATION_BASE_URL=http://127.0.0.1:1234/v1
DAILY_NEWS_TRANSLATION_API_KEY=YOUR-LOCAL-OR-CLOUD-KEY
DAILY_NEWS_TRANSLATION_MODEL=YOUR-MODEL
PORT=4173
```

Keep `.env` and `.env.local` local. Do not commit or paste their values.

`DAILY_NEWS_MAX_SOURCES` is optional. Leave it unset to fetch all enabled sources.

The translation variables are optional, but English-only official, sports and public social sources are skipped without them so the user-facing site remains Chinese.

## Smoke Checks

```bash
curl http://127.0.0.1:4173/api/health
curl http://127.0.0.1:4173/api/news
```

Expected behavior:

- `/api/health` returns `ok: true` after the first refresh.
- `/api/news` returns non-empty `items`.
- The frontend shows current hotspots, category tabs, search, date groups, trust labels and preference settings.

## Troubleshooting

- If live API is down, the frontend should fall back to `public/daily-news.json`.
- If Firecrawl returns sparse results, `scripts/newsService.ts` merges checked-in fallback items for category coverage.
- If Firecrawl keyless is unavailable or rate-limited, `scripts/newsService.ts` switches to direct public source page/feed fetching so enabled sources can still refresh from their own pages.
- If NBA, FIFA, FIBA or AI company blog items are missing, check whether the translation variables are configured; many of those sources return English-only title and summary text.
- If preference changes look ineffective, verify the active tab is `偏好新闻`; category tabs intentionally filter by category first.
- Refresh is polling-based. A source update appears after the next server refresh and frontend poll; the app does not receive source-side webhooks.
