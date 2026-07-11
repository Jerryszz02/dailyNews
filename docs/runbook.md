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

Run the same live quantitative gate without writing the fallback:

```bash
npm run verify-news
```

`npm run generate` uses the fixed first-phase profile: 10 direct sources, 3 candidates per section, no Firecrawl search, no model-based Chinese summary repair. It writes `public/daily-news.json` atomically only after both the quantitative gate and publish gate pass.

Offline V1-to-V2 report upgrade:

```bash
npm run upgrade-report
```

Verify:

```bash
npm test
npm run build
npm run verify-news
```

## Environment Variables

```bash
DAILY_NEWS_MAX_SOURCES=
DAILY_NEWS_LIMIT_PER_SECTION=5
DAILY_NEWS_REFRESH_INTERVAL_MINUTES=15
DAILY_NEWS_COLLECTION_BUDGET_MS=30000
DAILY_NEWS_SOURCE_CONCURRENCY=6
DAILY_NEWS_MAX_AGE_HOURS=72
DAILY_NEWS_REFRESH_TOKEN=
DAILY_NEWS_TRANSLATION_API_KEY=YOUR-DEEPSEEK-API-KEY
DAILY_NEWS_TRANSLATION_BASE_URL=
DAILY_NEWS_TRANSLATION_MODEL=
PORT=4173
```

Keep `.env` and `.env.local` local. Do not commit or paste their values.

`DAILY_NEWS_MAX_SOURCES` and `DAILY_NEWS_LIMIT_PER_SECTION` configure the default local background-refresh profile. Leave the source limit unset to select all enabled sources. `npm run generate`, `npm run verify-news` and Vercel refresh deliberately override them with 10 sources and 3 candidates per section.

`DAILY_NEWS_COLLECTION_BUDGET_MS` is the hard wall-clock deadline for one collection round. When a caller enables Firecrawl (the default local background refresh does), it gets at most the first 8 seconds; direct source work uses bounded concurrency from `DAILY_NEWS_SOURCE_CONCURRENCY`. The fixed generation and Vercel profiles disable Firecrawl.

Set `DAILY_NEWS_REFRESH_TOKEN` on Vercel before enabling `POST /api/refresh`. Send it as `Authorization: Bearer <token>`. Do not put the token in browser code.

`DAILY_NEWS_TRANSLATION_API_KEY` is optional and server-only. When set, the generator defaults to DeepSeek Flash (`https://api.deepseek.com` and `deepseek-v4-flash`) for shortlisted non-Chinese events only. Raw English candidates are filtered and clustered before translation, with a hard cap of 15 unique translated events per round. Set `DAILY_NEWS_TRANSLATION_BASE_URL` or `DAILY_NEWS_TRANSLATION_MODEL` only when overriding those defaults. On Vercel, configure the API key as a project environment variable, not in committed files.

The quantitative gate requires 10/10 primary-category coverage, valid Chinese title/summary text, a 72-hour freshness window, zero chronological inversions inside category sections, at most 20 source/search requests, at most 30 article requests, at most 15 translated events and zero repeated translations. Single-source share is reported but does not fail a round.

## Smoke Checks

```bash
curl http://127.0.0.1:4173/api/health
curl http://127.0.0.1:4173/api/news
```

Expected behavior:

- `/api/health` returns `ok: true` immediately when a bundled last-known-good report exists.
- `/api/news` returns `version: 2`, non-empty `stories` and legacy `items` without waiting for external fetching.
- The frontend shows 今日必知、重要进展、持续关注、分类深读、搜索和偏好设置。

## Troubleshooting

- If live API is down, the frontend should fall back to `public/daily-news.json`.
- In the local background-refresh profile, if Firecrawl returns no fresh results, `scripts/newsService.ts` switches to direct public source page/feed fetching. Fixed generation and Vercel refresh start with direct fetching.
- If neither Firecrawl nor direct fetching returns fresh results, the service uses the checked-in fallback report.
- If a generation round misses any primary beat or violates freshness, ordering, language or cost limits, the quantitative gate keeps the previous report.
- If NBA, FIFA, FIBA or AI company blog items are missing, check whether `DAILY_NEWS_TRANSLATION_API_KEY` is configured; many of those sources return English-only title and summary text.
- Preferences only reorder important/category stories; they never hide or promote `must_know` events.
- Refresh is polling-based. A source update appears after the next server refresh and frontend poll; the app does not receive source-side webhooks.
