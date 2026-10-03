import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { collectSource } from "@aihot/backend/sources/collect";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { fetchFirecrawlFallback, firecrawlFallbackEnabled, parseFirecrawlSearch } from "@aihot/backend/sources/firecrawl-fallback";
import { fetchSitemap } from "@aihot/backend/sources/sitemap";
import { allowed } from "@aihot/backend/sources/web-list";
import { fetchOfficialX } from "@aihot/backend/sources/x-official";
import { makeInventory, renderInventoryMarkdown } from "../scripts/dailynews-source-inventory.ts";
import { tag } from "./setup.ts";

const baseline = JSON.parse(readFileSync(new URL("../reference/baselines/legacy-sources.json", import.meta.url), "utf8"));
const seed = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8"));
const inventory = makeInventory(baseline);
const asSource = (row: any) => ({ ...row, cursor: null, fail_count: 0 });

test("frozen inventory maps every legacy section with stable identity and disabled admission", () => {
  assert.equal(baseline.sources.length, 169);
  assert.equal(inventory.length, 187);
  assert.deepEqual(seed.sources, inventory);
  assert.equal(new Set(inventory.map((r) => r.id)).size, 187);
  assert.equal(new Set(inventory.map((r) => (r.config.dailyNews as any).legacySourceId)).size, 169);
  assert.equal((inventory.find((r) => (r.config.dailyNews as any).legacySourceId === "xinhua")!.config.dailyNews as any).sectionId, "f77f0b3178db");
  assert.equal(inventory.find((r) => (r.config.dailyNews as any).legacySourceId === "openai")!.tier, "T1");
  assert.equal(inventory.find((r) => (r.config.dailyNews as any).legacySourceId === "x-openai")!.tier, "T1");
  assert.equal(inventory.find((r) => (r.config.dailyNews as any).legacySourceId === "xinhua")!.tier, "T2");
  assert.match((inventory.find((r) => (r.config.dailyNews as any).legacySourceId === "xinhua")!.config.dailyNews as any).tierReason, /待逐来源复核/);
  assert.equal(inventory.filter((r) => !(r.config.dailyNews as any).legacyEnabled).length, 14);
  assert(inventory.every((r) => !r.enabled && !(r.config.dailyNews as any).firecrawlFallback));
  assert(inventory.every((r) => r.first_party ? r.owner_entity_id === (r.config.dailyNews as any).publisherKey.slice("publisher:".length) : r.owner_entity_id === null));
  assert(inventory.every((r) => unsupportedConfig(r.kind, r.config).length === 0));
  assert(!inventory.some((r) => r.config.query || r.config.searchType)); // no SocialData queries
  const doc = readFileSync(new URL("../docs/source-migration-inventory.md", import.meta.url), "utf8");
  assert.equal(doc, renderInventoryMarkdown(inventory));
  assert.equal(doc.split("\n").filter((line) => line.startsWith("| dn-")).length, 187);
  const xinhua = inventory.filter((r) => (r.config.dailyNews as any).legacySourceId === "xinhua");
  assert(xinhua.length > 1 && xinhua.every((r) => (r.config.dailyNews as any).publisherKey === "publisher:xinhua"));
  assert.equal((inventory.find((r) => (r.config.dailyNews as any).legacySourceId === "x-xhnews")!.config.dailyNews as any).publisherKey, "publisher:xinhua");
  assert.equal((inventory.find((r) => (r.config.dailyNews as any).legacySourceId === "bbc-sport")!.config.dailyNews as any).publisherKey, "publisher:bbc");
});

test("source boundary rejects non-HTTPS, unapproved hosts and unrelated paths", () => {
  const source = asSource({ config: { dailyNews: { allowedHosts: ["example.org"], allowedPathPrefixes: ["example.org/news"] } } }) as never;
  assert(allowed("https://www.example.org/news/item", source));
  assert(!allowed("https://evil-example.org/news/item", source));
  assert(!allowed("http://example.org/news/item", source));
  assert(!allowed("https://example.org/other/item", source));
  assert(!allowed("https://example.org:8443/news/item", source));
  const verifiedWeb = { dailyNews: {
    adapter: "web_list", migrationStatus: "verified", allowedHosts: ["example.org"],
    publisherKey: "publisher:example", legacySourceId: "example", sectionId: "news",
  } };
  assert(unsupportedConfig("web_list", verifiedWeb).includes("dailyNews.verifiedWebSelectors"));
  assert(!unsupportedConfig("web_list", { ...verifiedWeb, itemSelector: "article", linkSelector: "a", titleSelector: "h2" }).length);
  assert(!unsupportedConfig("json_list", { ...verifiedWeb, dailyNews: { ...verifiedWeb.dailyNews, adapter: "json_list" } }).length);
});

test("sitemap reads bounded news entries and does not use lastmod as publication time", async () => {
  const source = asSource({ config: { url: "https://example.org/sitemap.xml", dailyNews: { allowedHosts: ["example.org"], allowedPathPrefixes: [] } } }) as never;
  let requests = 0;
  const request = async (url: string) => {
    requests++;
    const xml = url.endsWith("sitemap.xml")
      ? `<sitemapindex><sitemap><loc>https://example.org/news.xml</loc></sitemap></sitemapindex>`
      : `<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"><url><loc>https://example.org/news/1</loc><lastmod>2026-10-02</lastmod><news:news><news:title>今日新闻</news:title><news:publication_date>2026-10-01T04:00:00Z</news:publication_date></news:news></url><url><loc>https://example.org/news/1</loc><news:news><news:title>重复新闻</news:title></news:news></url><url><loc>https://example.org/generic</loc><lastmod>2026-10-03</lastmod></url></urlset>`;
    return { status: 200, url, headers: new Headers(), body: Buffer.from(xml), text: () => xml };
  };
  const result = await fetchSitemap(source, request);
  assert.equal(requests, 2);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.publishedAt?.toISOString(), "2026-10-01T04:00:00.000Z");
  assert.equal(result.candidates[0]!.sourceUpdatedAt?.toISOString(), "2026-10-02T00:00:00.000Z");
});

test("keyless search fixture remains bounded by three results and approved hosts", () => {
  const source = asSource({ config: { dailyNews: { allowedHosts: ["example.org"], allowedPathPrefixes: [] } } }) as never;
  const news = [
    { url: "https://example.org/news/1", title: "一", description: "原文摘要", date: "2026-10-01T00:00:00Z" },
    { url: "https://unapproved.org/story", title: "二" },
    { url: "https://example.org/news/3", title: "三" },
    { url: "https://example.org/news/4", title: "四" },
  ];
  const candidates = parseFirecrawlSearch({ news }, source);
  assert.deepEqual(candidates.map((c) => c.url), ["https://example.org/news/1", "https://example.org/news/3"]);
  assert.equal(candidates[0]!.excerpt, "原文摘要");
  assert.throws(() => parseFirecrawlSearch({ other: [] }, source), /malformed/);
});

test("official X requires opt-in, keeps a page cursor and filters foreign/reply posts", async () => {
  const row = inventory.find((r) => (r.config.dailyNews as any).legacySourceId === "x-xhnews")!;
  const source = asSource(row);
  delete process.env.DAILY_NEWS_OFFICIAL_X_ENABLED;
  let hits = 0;
  await assert.rejects(fetchOfficialX(source, { request: async () => { hits++; return { status: 200, body: {} }; } }));
  assert.equal(hits, 0);
  process.env.DAILY_NEWS_OFFICIAL_X_ENABLED = "true";
  process.env.DAILY_NEWS_X_BEARER_TOKEN = "offline-test-bearer";
  const now = new Date("2026-10-03T00:00:00Z");
  const urls: string[] = [];
  const request = async (url: string) => {
    urls.push(url);
    if (url.includes("/by/username/")) return { status: 200, body: { data: { id: "123" } } };
    return { status: 200, body: { data: [
      { id: "999", author_id: "123", created_at: "2026-10-02T00:00:00Z", text: "今日新闻。详情" },
      { id: "999", author_id: "123", created_at: "2026-10-02T00:00:00Z", text: "同一帖重复" },
      { id: "998", author_id: "456", created_at: "2026-10-02T00:00:00Z", text: "外部账户" },
      { id: "997", author_id: "123", created_at: "2026-10-02T00:00:00Z", text: "回复", referenced_tweets: [{ type: "replied_to" }] },
    ], meta: { next_token: "page-2" } } };
  };
  try {
    const first = await fetchOfficialX(source, { request, now, maxPages: 1 });
    assert.equal(first.candidates.length, 1);
    assert.equal(first.candidates[0]!.identityKey, "x:999");
    assert(first.partial);
    assert.equal(first.cursor.pageToken, "page-2");
    source.cursor = { officialX: first.cursor };
    const second = await fetchOfficialX(source, { request: async (url) => {
      urls.push(url);
      return { status: 200, body: { data: [], meta: {} } };
    }, now });
    assert(!second.partial);
    assert.equal(second.cursor.sinceId, "999");
    assert(urls.at(-1)!.includes("pagination_token=page-2"));
  } finally {
    delete process.env.DAILY_NEWS_OFFICIAL_X_ENABLED;
    delete process.env.DAILY_NEWS_X_BEARER_TOKEN;
  }
});

test("seeded sections stay inert under force; DB publisher grouping and fallback budget are explicit", async () => {
  const rows = inventory.filter((r) => (r.config.dailyNews as any).legacySourceId === "xinhua").slice(0, 2);
  const ids = rows.map((r) => `${r.id}-${tag()}`);
  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const fixtureConfig = { ...row.config, dailyNews: { ...(row.config.dailyNews as object), sectionId: ids[i]! } };
      await sql`INSERT INTO sources (id, name, kind, config, enabled) VALUES (${ids[i]!}, ${row.name}, ${row.kind}, ${sql.json(fixtureConfig as never)}, false)`;
    }
    const stored = await sql<{ id: string; publisher_key: string; legacy_source_id: string; legacy_section_id: string; signal_group_id: string }[]>`
      SELECT id, publisher_key, legacy_source_id, legacy_section_id, signal_group_id FROM sources WHERE id = ANY(${ids}::text[]) ORDER BY id`;
    assert.equal(stored.length, 2);
    assert(stored.every((r) => r.publisher_key === "publisher:xinhua" && r.signal_group_id === r.publisher_key && r.legacy_source_id === "xinhua" && !!r.legacy_section_id));
    const result = await collectSource(ids[0]!, { force: true });
    assert.equal(result.status, "skipped");
    assert.equal(result.error, "migration unverified");
    const runs = await sql`SELECT id FROM fetch_runs WHERE source_id = ${ids[0]!}`;
    assert.equal(runs.length, 0);
    const failedId = `dn-offline-cursor-${tag()}`;
    ids.push(failedId);
    const failedConfig = { dailyNews: { ...(rows[0]!.config.dailyNews as object), sectionId: failedId, adapter: "rss", migrationStatus: "verified" } };
    await sql`INSERT INTO sources (id, name, kind, config, enabled, cursor)
      VALUES (${failedId}, 'offline cursor fixture', 'rss', ${sql.json(failedConfig as never)}, true,
              ${sql.json({ initializedAt: "2026-10-01T00:00:00Z", rss: { etag: "old" } } as never)})`;
    const failed = await collectSource(failedId);
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /feedUrl missing/);
    const [unchanged] = await sql<{ cursor: Record<string, any> }[]>`SELECT cursor FROM sources WHERE id = ${failedId}`;
    assert.equal(unchanged!.cursor.rss.etag, "old");
    const [budget] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'firecrawl'`;
    assert.deepEqual([budget?.per_minute, budget?.per_hour, budget?.per_day], [0, 0, 0]);
    process.env.DAILY_NEWS_FIRECRAWL_FALLBACK_ENABLED = "true";
    delete process.env.FIRECRAWL_API_KEY;
    assert(!firecrawlFallbackEnabled(asSource(rows[0]!) as never));
    const fallbackSource = asSource({ ...rows[0]!, config: { ...rows[0]!.config, dailyNews: {
      ...(rows[0]!.config.dailyNews as object), migrationStatus: "verified", firecrawlFallback: { enabled: true },
      searchTerms: ["test news"], allowedHosts: ["example.org"],
    } } });
    assert(firecrawlFallbackEnabled(fallbackSource as never));
    await assert.rejects(fetchFirecrawlFallback(fallbackSource as never), /Budget for firecrawl exhausted/);
  } finally {
    delete process.env.DAILY_NEWS_FIRECRAWL_FALLBACK_ENABLED;
    delete process.env.FIRECRAWL_API_KEY;
    await sql`DELETE FROM sources WHERE id = ANY(${ids}::text[])`;
    await closeDb();
  }
});
