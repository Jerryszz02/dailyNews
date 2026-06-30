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
FIRECRAWL_API_KEY=fc-YOUR-API-KEY
DAILY_NEWS_MAX_SOURCES=20
DAILY_NEWS_LIMIT_PER_SECTION=5
DAILY_NEWS_REFRESH_INTERVAL_MINUTES=15
PORT=4173
```

Keep `.env` and `.env.local` local. Do not commit or paste their values.

## Smoke Checks

```bash
curl http://127.0.0.1:4173/api/health
curl http://127.0.0.1:4173/api/news
```

Expected behavior:

- `/api/health` returns `ok: true` after the first refresh.
- `/api/news` returns non-empty `items`.
- The frontend shows current hotspots, category tabs, search, date groups and preference settings.

## Troubleshooting

- If live API is down, the frontend should fall back to `public/daily-news.json`.
- If Firecrawl returns sparse results, `scripts/newsService.ts` merges checked-in fallback items for category coverage.
- If preference changes look ineffective, verify the active tab is `偏好新闻`; category tabs intentionally filter by category first.
