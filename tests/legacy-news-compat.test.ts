import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Fastify from "fastify";
import { registerLegacyNews } from "../apps/api/src/routes/legacy-news.ts";

const SHA = "38cbdbbd00865a735ba01095d26a1bdfccdcea959dd5fbbd4c2c8f1e40af9f36";

async function server(options: Parameters<typeof registerLegacyNews>[1] = {}) {
  const app = Fastify({ logger: false });
  registerLegacyNews(app, options);
  await app.ready();
  return app;
}

test("unconfigured V2 boundary never substitutes the frozen report", async () => {
  const app = await server({ baseUrl: "" });
  try {
    const response = await app.inject({ method: "GET", url: "/api/news?view=web" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.json().code, "legacy_schema_unavailable");
    assert.match(response.json().detail, /\/api\/v1\/items/);
    assert.match(response.json().detail, /\/api\/legacy\/archive/);
  } finally { await app.close(); }
});

test("GET preserves actual V2 body, status and allowed query without forwarding credentials", async () => {
  const hits: Array<{ url: string; init: RequestInit }> = [];
  const original = Buffer.from('{"version":2,"generatedAt":"2026-07-09T15:39:06.365Z","quality":{"score":17}}');
  const app = await server({ baseUrl: "https://legacy.example/", fetcher: async (url, init) => {
    hits.push({ url: String(url), init: init! });
    return new Response(original, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=30", "set-cookie": "secret=bad" } });
  } });
  try {
    const response = await app.inject({ method: "GET", url: "/api/news?view=web&reload=1", headers: { authorization: "Bearer private", cookie: "session=private" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, original.toString());
    assert.equal(response.headers["cache-control"], "public, max-age=30");
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.url, "https://legacy.example/api/news?view=web&reload=1");
    assert.deepEqual(hits[0]!.init.headers, { Accept: "application/json" });
    assert.equal(hits[0]!.init.redirect, "manual");
    assert.equal(hits[0]!.init.credentials, "omit");
  } finally { await app.close(); }
});

test("invalid queries, methods, redirects and upstream failures fail closed", async () => {
  let hits = 0;
  const app = await server({ baseUrl: "https://legacy.example", fetcher: async () => { hits++; return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }); } });
  try {
    for (const query of ["?reload=1", "?view=full", "?view=web&view=web", "?_=" ]) {
      const response = await app.inject({ method: "GET", url: `/api/news${query}` });
      assert.equal(response.statusCode, 400, query);
    }
    assert.equal((await app.inject({ method: "POST", url: "/api/news" })).statusCode, 405);
    const redirected = await app.inject({ method: "GET", url: "/api/news" });
    assert.equal(redirected.statusCode, 503);
    assert.equal(redirected.json().code, "legacy_upstream_unavailable");
    assert.equal(hits, 1);
  } finally { await app.close(); }
  assert.throws(() => registerLegacyNews(Fastify(), { baseUrl: "http://localhost:1234" }), /HTTPS origin/);
  assert.throws(() => registerLegacyNews(Fastify(), { baseUrl: "https://legacy.example/path" }), /HTTPS origin/);
});

test("upstream rate limit is preserved but 5xx and oversized bodies are rejected", async () => {
  let mode: "rate-limit" | "oversized" | "server-error" = "rate-limit";
  const app = await server({ baseUrl: "https://legacy.example", fetcher: async () => mode === "oversized"
    ? new Response("large", { headers: { "content-type": "application/json", "content-length": String(9 * 1024 * 1024) } })
    : mode === "server-error"
      ? new Response('{"error":"Internal server error"}', { status: 500, headers: { "content-type": "application/json" } })
      : new Response('{"error":"Too many reload requests"}', { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } }) });
  try {
    const limited = await app.inject({ method: "GET", url: "/api/news?view=web&reload=1" });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers["retry-after"], "60");
    assert.equal(limited.body, '{"error":"Too many reload requests"}');
    mode = "oversized";
    const rejected = await app.inject({ method: "GET", url: "/api/news" });
    assert.equal(rejected.statusCode, 503);
    assert.equal(rejected.headers["cache-control"], "no-store");
    mode = "server-error";
    const failed = await app.inject({ method: "GET", url: "/api/news" });
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().code, "legacy_upstream_unavailable");
    assert.doesNotMatch(failed.body, /Internal server error/);
  } finally { await app.close(); }
});

test("legacy refresh and cron endpoints are gone, not new admin aliases", async () => {
  const app = await server({ baseUrl: "" });
  try {
    for (const [method, url] of [["POST", "/api/refresh"], ["GET", "/api/cron"]] as const) {
      const response = await app.inject({ method, url });
      assert.equal(response.statusCode, 410);
      assert.equal(response.json().code, "legacy_write_endpoint_gone");
      assert.equal(response.headers["cache-control"], "no-store");
    }
  } finally { await app.close(); }
});

test("frozen archive returns its exact bytes and maps only recorded event and candidate IDs", async () => {
  const app = await server({ baseUrl: "" });
  try {
    const original = await readFile(new URL("../public/daily-news.json", import.meta.url));
    assert.equal(createHash("sha256").update(original).digest("hex"), SHA);
    const report = JSON.parse(original.toString("utf8"));
    const index = await app.inject({ method: "GET", url: "/api/legacy/archive" });
    assert.equal(index.statusCode, 200);
    assert.deepEqual({ live: index.json().live, count: index.json().storyCount, sha256: index.json().sha256 }, { live: false, count: 47, sha256: SHA });
    const snapshot = await app.inject({ method: "GET", url: "/api/legacy/archive/report" });
    assert.equal(snapshot.statusCode, 200);
    assert.deepEqual(snapshot.rawPayload, original);
    assert.equal(snapshot.headers["x-legacy-archive-sha256"], SHA);
    const story = report.stories[0];
    const event = await app.inject({ method: "GET", url: `/api/legacy/archive/stories/${encodeURIComponent(story.id)}` });
    assert.equal(event.statusCode, 200);
    assert.deepEqual(event.json().story, story);
    assert.deepEqual(event.json().item, report.items.find((item: { id: string }) => item.id === story.itemId));
    const candidateId = story.evidence[1].candidateId;
    const candidate = await app.inject({ method: "GET", url: `/api/legacy/archive/candidates/${encodeURIComponent(candidateId)}` });
    assert.equal(candidate.statusCode, 200);
    assert.equal(candidate.json().candidateId, candidateId);
    assert(candidate.json().evidence.some((entry: { storyId: string }) => entry.storyId === story.id));
    for (const url of ["/api/legacy/archive/stories/event-missing", "/api/legacy/archive/candidates/missing", "/api/legacy/archive/dailies/daily-2026-07-09"]) {
      const missing = await app.inject({ method: "GET", url });
      assert.equal(missing.statusCode, 404, url);
      assert.equal(missing.json().code, "legacy_id_not_archived");
    }
  } finally { await app.close(); }
});
