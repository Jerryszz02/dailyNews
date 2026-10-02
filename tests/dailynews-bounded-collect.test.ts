import "./setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { test } from "node:test";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { boundedIncrementalCandidates, collectSource } from "@aihot/backend/sources/collect";
import { validateManifest, mapBounded } from "../scripts/bounded-trial.ts";
import { modelExecutionBounds, trialReport } from "../scripts/bounded-trial-report.ts";
import { tag } from "./setup.ts";

test("observed model limits count overlaps and rolling-window edges", () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 9, 3) + ms);
  const attempts = [
    { started_at: at(0), finished_at: at(5000) },
    { started_at: at(1000), finished_at: at(2000) },
    { started_at: at(2000), finished_at: at(5000) },
    { started_at: at(60_000), finished_at: null },
  ];
  assert.deepEqual(modelExecutionBounds(attempts, at(70_000)), {
    attempts: 4, peakReservedSlots: 2, peakPerMinute: 3, peakPerHour: 4, peakPerDay: 4,
  });
  assert.deepEqual(modelExecutionBounds([], at(0)), {
    attempts: 0, peakReservedSlots: 0, peakPerMinute: 0, peakPerHour: 0, peakPerDay: 0,
  });
});

test("fixed manifest and four-way scheduler reject silent expansion", async () => {
  const sourceIds = Array.from({ length: 14 }, (_, i) => `dn-bounded-${i}`);
  const manifest = validateManifest({ id: "p5-offline", sourceIds, maxNormal: 100, maxHistorical: 20,
    collectionConcurrency: 4, modelConcurrency: 2, modelBudget: { perMinute: 20, perHour: 200, perDay: 1000 } });
  assert.equal(manifest.sourceIds.length, 14);
  assert.throws(() => validateManifest({ ...manifest, sourceIds: [...sourceIds, sourceIds[0]] }), /distinct/);
  assert.throws(() => validateManifest({ ...manifest, maxNormal: 101 }), /limits/);
  assert.throws(() => validateManifest({ ...manifest, modelBudget: { ...manifest.modelBudget, perDay: 0 } }), /budget/);
  let inFlight = 0;
  let peak = 0;
  const release: Array<() => void> = [];
  const running = mapBounded(sourceIds, 4, async (id) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((resolve) => release.push(resolve));
    inFlight -= 1;
    return id;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 4);
  while (release.length) {
    release.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(await running, sourceIds);
});

test("incremental listing excludes source timestamps at or before its real baseline", () => {
  const baseline = new Date("2026-10-03T00:00:00Z");
  const candidate = (id: number, publishedAt: Date | null) => ({ url: `https://example.org/${id}`, title: `${id}`, publishedAt });
  const list = [candidate(1, new Date("2026-10-02T23:59:59Z")), candidate(2, baseline),
    candidate(3, new Date("2026-10-03T00:00:01Z")), candidate(4, null)];
  assert.deepEqual(boundedIncrementalCandidates(list, baseline, false).map((c) => c.title), ["3", "4"]);
  assert.deepEqual(boundedIncrementalCandidates(list, baseline, true).map((c) => c.title), ["1", "2", "3", "4"],
    "a feed date marked nonauthoritative must be checked on the detail page");
  assert.equal(boundedIncrementalCandidates(Array.from({ length: 200 }, (_, i) => candidate(i, null)), baseline, false).length, 100);
});

test("trial rejects a source outside its manifest before any fetch or fetch-run row", async () => {
  const prefix = `bounded-${tag()}`;
  const ids = Array.from({ length: 11 }, (_, i) => `${prefix}-${i}`);
  const previous = {
    mode: process.env.DAILYNEWS_TRIAL_MODE, id: process.env.DAILYNEWS_TRIAL_ID,
    hash: process.env.DAILYNEWS_TRIAL_SETTINGS_HASH, db: process.env.DAILYNEWS_TRIAL_DB_NAME,
    band: process.env.DAILYNEWS_DEEPSEEK_PRICE_BAND,
    from: process.env.DAILYNEWS_DEEPSEEK_PRICE_VALID_FROM, until: process.env.DAILYNEWS_DEEPSEEK_PRICE_VALID_UNTIL,
  };
  const modelKeys = ["STRUCTURE_MODEL", "PREFILTER_MODEL", "SCORE_MODEL", "UNDERSTAND_MODEL", "SUMMARIZE_MODEL",
    "GROUP_MODEL", "GROUP_REVIEW_MODEL", "DIGEST_MODEL", "REPORT_MODEL", "DEEPSEEK_BASE_URL", "DEEPSEEK_API_KEY"] as const;
  const previousModels = Object.fromEntries(modelKeys.map((key) => [key, process.env[key]]));
  const budgets = await sql<{ service: string; per_minute: number; per_hour: number; per_day: number; note: string | null }[]>`
    SELECT service,per_minute,per_hour,per_day,note FROM budgets WHERE service IN ('deepseek','llm-global')`;
  const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  const trialId = `${prefix}-trial`;
  let receiptId: number | null = null;
  const oldPrivateFetch = config.allowPrivateNetworkFetch;
  const server = http.createServer((req, res) => {
    if (req.url === "/fail") { res.writeHead(503); res.end("unavailable"); return; }
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end("<rss version=\"2.0\"><channel><title>空订阅</title></channel></rss>");
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    config.allowPrivateNetworkFetch = true;
    process.env.DAILYNEWS_TRIAL_DB_NAME = database;
    process.env.DAILYNEWS_DEEPSEEK_PRICE_BAND = "off_peak";
    process.env.DAILYNEWS_DEEPSEEK_PRICE_VALID_FROM = new Date(Date.now() - 86_400_000).toISOString();
    process.env.DAILYNEWS_DEEPSEEK_PRICE_VALID_UNTIL = new Date(Date.now() + 86_400_000).toISOString();
    for (const key of modelKeys.slice(0, -2)) process.env[key] = "deepseek-flash";
    process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
    process.env.DEEPSEEK_API_KEY = "offline-test-value";
    await sql`UPDATE budgets SET per_minute=20,per_hour=200,per_day=1000 WHERE service='deepseek'`;
    await sql`INSERT INTO budgets (service,per_minute,per_hour,per_day,note)
      VALUES ('llm-global',20,200,1000,'offline trial test')
      ON CONFLICT (service) DO UPDATE SET per_minute=20,per_hour=200,per_day=1000`;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const adapter = i === 8 ? "web_list" : i === 9 ? "sitemap" : "rss";
      const kind = i === 8 || i === 9 ? "web_list" : "rss";
      const sourceConfig = { ...(i < 2 ? { feedUrl: `${base}/${i === 0 ? "fail" : "ok"}` } : {}),
        ...(i === 8 ? { url: `${base}/list`, itemSelector: "article", linkSelector: "a", titleSelector: "h2" } : {}),
        ...(i === 9 ? { url: `${base}/sitemap.xml` } : {}),
        dailyNews: { migrationStatus: "verified", adapter, allowedHosts: ["127.0.0.1"],
        legacySourceId: `${prefix}-${i}`,
        sectionId: "main", publisherKey: `publisher:${prefix}-${i}` } };
      await sql`INSERT INTO sources (id,name,kind,config,enabled) VALUES (${id},${id},${kind},${sql.json(sourceConfig as never)},true)`;
    }
    const manifest = { id: trialId, sourceIds: ids.slice(0, 10), maxNormal: 100, maxHistorical: 20,
      collectionConcurrency: 4, modelConcurrency: 2, modelBudget: { perMinute: 20, perHour: 200, perDay: 1000 } };
    const initialized = spawnSync(process.execPath, ["scripts/bounded-trial.ts", "init", "--manifest", "/dev/stdin"], {
      env: process.env, input: JSON.stringify(manifest), encoding: "utf8", cwd: process.cwd(),
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    const trial = JSON.parse(initialized.stdout) as { sourceCount: number; settingsHash: string };
    assert.equal(trial.sourceCount, 10);
    process.env.DAILYNEWS_TRIAL_MODE = "bounded";
    process.env.DAILYNEWS_TRIAL_ID = trialId;
    process.env.DAILYNEWS_TRIAL_SETTINGS_HASH = trial.settingsHash;
    delete process.env.DAILYNEWS_TRIAL_MODE;
    delete process.env.DAILYNEWS_TRIAL_ID;
    delete process.env.DAILYNEWS_TRIAL_SETTINGS_HASH;
    delete process.env.DAILYNEWS_TRIAL_DB_NAME;
    await assert.rejects(collectSource(ids[0]!), /trial database requires explicit runtime settings/);
    assert.equal((await sql`SELECT id FROM fetch_runs WHERE source_id=${ids[0]!}`).length, 0,
      "omitting runtime flags cannot start an unbounded fetch against a trial database");
    process.env.DAILYNEWS_TRIAL_MODE = "bounded";
    process.env.DAILYNEWS_TRIAL_ID = trialId;
    process.env.DAILYNEWS_TRIAL_SETTINGS_HASH = trial.settingsHash;
    process.env.DAILYNEWS_TRIAL_DB_NAME = database;
    await assert.rejects(collectSource(ids[10]!), /outside trial manifest/);
    assert.equal((await sql`SELECT id FROM fetch_runs WHERE source_id=${ids[10]!}`).length, 0);
    const [failed, succeeded] = await mapBounded(ids.slice(0, 2), 4, (id) => collectSource(id));
    assert.equal(failed?.status, "failed");
    assert.match(failed?.error ?? "", /HTTP 503/);
    assert.equal(succeeded?.status, "ok", "a failed HTTP source cannot stop another source");
    const [source] = await sql<{ initialized_at: Date | null }[]>`
      SELECT initialized_at FROM dailynews_trial_sources WHERE trial_id=${trialId} AND source_id=${ids[0]!}`;
    assert(source?.initialized_at instanceof Date, "first actual attempt freezes this source's baseline");
    const [run] = await sql<{ detail: { boundedTrial?: { id: string } } }[]>`
      SELECT detail FROM fetch_runs WHERE source_id=${ids[0]!} ORDER BY id DESC LIMIT 1`;
    assert.equal(run?.detail.boundedTrial?.id, trialId);
    const report = await trialReport(trialId);
    assert.equal(report.sources.length, 10);
    assert.equal(report.sources.find((row) => row.source_id === ids[0])?.status, "failed");
    assert.equal(report.sources.find((row) => row.source_id === ids[1])?.status, "ok");
    assert.equal(report.cohort.normal, 0);
    assert.equal(report.qualityLabels.status, "awaiting-human-review");
    const cli = (...args: string[]) => spawnSync(process.execPath, ["scripts/bounded-trial.ts", ...args], {
      env: process.env, encoding: "utf8", cwd: process.cwd(),
    });
    const status = cli("status", "--id", trialId);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).trial.id, trialId);
    const earlyDaily = cli("daily", "--id", trialId, "--date", "2999-01-01");
    assert.notEqual(earlyDaily.status, 0, "future daily editions cannot be admitted or written early");
    assert.equal((await sql`SELECT 1 FROM dailynews_trial_reports WHERE trial_id=${trialId}`).length, 0);
    const invalidDaily = cli("daily", "--id", trialId, "--date", "2026-02-30");
    assert.notEqual(invalidDaily.status, 0);
    const validUntil = process.env.DAILYNEWS_DEEPSEEK_PRICE_VALID_UNTIL!;
    process.env.DAILYNEWS_DEEPSEEK_PRICE_VALID_UNTIL = "2020-01-01T00:00:00Z";
    const freeze = cli("freeze", "--id", trialId);
    process.env.DAILYNEWS_DEEPSEEK_PRICE_VALID_UNTIL = validUntil;
    assert.equal(freeze.status, 0, freeze.stderr);
    assert.equal((await collectSource(ids[2]!)).status, "skipped", "freeze stops collection before network");
    assert.equal((await sql`SELECT id FROM fetch_runs WHERE source_id=${ids[2]!}`).length, 0);
    // Processing of already admitted material can continue after freeze. Its expense is still
    // part of the trial, even though new collection/admission is closed.
    const [receipt] = await sql<{ id: number }[]>`
      INSERT INTO receipts (logical_key,service,purpose,subject,status,origin,attempts)
      VALUES (${`${trialId}:after-freeze`},'deepseek','source_search',${`source:${ids[0]!}`},'completed','live',1)
      RETURNING id`;
    receiptId = receipt!.id;
    await sql`INSERT INTO receipt_attempts (receipt_id,attempt,service,status,origin,cost,currency,cost_basis)
      VALUES (${receiptId},1,'deepseek','received','live',0.012,'USD','estimated')`;
    const afterFreeze = await trialReport(trialId);
    assert.equal(afterFreeze.trial.status, "frozen");
    assert(afterFreeze.trial.frozenAt);
    assert.equal(afterFreeze.provider.attempts.reduce((sum, row) => sum + row.attempts, 0), 1);
    assert.equal(afterFreeze.provider.mixedCosts.find((row) => row.subject_kind === "source")?.cost, 0.012);
    const closed = cli("close", "--id", trialId);
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal((await trialReport(trialId)).trial.status, "closed");
    assert.notEqual(cli("collect", "--id", trialId).status, 0, "closing cannot restart collection");
    // Diagnostic fixture only: even if an operator writes a post-close expense directly,
    // accounting must expose it instead of trimming the financial record at closed_at.
    await sql`INSERT INTO receipt_attempts (receipt_id,attempt,service,status,origin,cost,currency,cost_basis,started_at)
      VALUES (${receiptId},2,'deepseek','received','live',0.003,'USD','estimated',clock_timestamp())`;
    const postClose = await trialReport(trialId);
    assert.equal(postClose.provider.attemptsStartedAfterClose, 1);
    assert.equal(postClose.provider.mixedCosts.find((row) => row.subject_kind === "source")?.cost, 0.015);
  } finally {
    for (const [key, value] of [["DAILYNEWS_TRIAL_MODE", previous.mode], ["DAILYNEWS_TRIAL_ID", previous.id],
      ["DAILYNEWS_TRIAL_SETTINGS_HASH", previous.hash], ["DAILYNEWS_TRIAL_DB_NAME", previous.db],
      ["DAILYNEWS_DEEPSEEK_PRICE_BAND", previous.band], ["DAILYNEWS_DEEPSEEK_PRICE_VALID_FROM", previous.from],
      ["DAILYNEWS_DEEPSEEK_PRICE_VALID_UNTIL", previous.until]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const key of modelKeys) {
      const value = previousModels[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (receiptId) await sql`DELETE FROM receipts WHERE id=${receiptId}`;
    await sql`DELETE FROM dailynews_trial_sources WHERE trial_id=${trialId}`;
    await sql`DELETE FROM dailynews_trials WHERE id=${trialId}`;
    await sql`DELETE FROM fetch_runs WHERE source_id=ANY(${ids}::text[])`;
    await sql`DELETE FROM sources WHERE id=ANY(${ids}::text[])`;
    for (const service of ["deepseek", "llm-global"]) {
      const budget = budgets.find((row) => row.service === service);
    if (budget) await sql`UPDATE budgets SET per_minute=${budget.per_minute},per_hour=${budget.per_hour},per_day=${budget.per_day},note=${budget.note} WHERE service=${service}`;
      else await sql`DELETE FROM budgets WHERE service=${service}`;
    }
    config.allowPrivateNetworkFetch = oldPrivateFetch;
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb();
  }
});
