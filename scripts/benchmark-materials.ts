// Offline storage benchmark. Refuses production databases and never invokes collectors/models.
import assert from "node:assert/strict";
import postgres from "postgres";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { closeDb, type Db } from "../packages/backend/src/db.ts";
import type { MaterialInput } from "../packages/backend/src/content/materials.ts";
const databaseUrl = process.env.DATABASE_URL ?? "";
assert.match(new URL(databaseUrl).pathname, /_(test|ci)$/);
const baseline = process.argv.includes("--baseline");
const allNew = process.argv.includes("--all-new");
const baselineRef = process.argv.find((arg) => arg.startsWith("--baseline-ref="))?.slice("--baseline-ref=".length) ?? "7234523ca164b49a0fd3495548adf877ee2b834a";
const temporaryModule = new URL(`../packages/backend/src/content/materials.benchmark-${process.pid}.ts`, import.meta.url);
if (baseline) writeFileSync(temporaryModule, execFileSync("git", ["show", `${baselineRef}:packages/backend/src/content/materials.ts`]));
const { upsertMaterial } = await import(baseline ? temporaryModule.href : "../packages/backend/src/content/materials.ts");
let queries = 0;
const db = postgres(databaseUrl, { max: 1, onnotice: () => {}, debug: () => { queries++; }, connection: { jit: "off" } });
const results: unknown[] = [];
try {
  for (let run = 0; run < 6; run++) {
    const source = `bench-material-${Date.now()}-${run}`;
    await db`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${source}, 'Offline benchmark', 'rss', '2100-01-01')`;
    const input = (i: number): MaterialInput => ({ sourceId: source, url: `https://benchmark.invalid/${source}/${i}`, title: `News ${i}`, excerpt: `Summary ${i}`, via: "fetch" });
    for (let i = 0; i < (allNew ? 0 : 990); i++) await upsertMaterial(input(i), db as unknown as Db);
    queries = 0;
    const cpu = process.cpuUsage();
    const started = performance.now();
    const counts = { unchanged: 0, created: 0, revised: 0 };
    for (let i = 0; i < 1000; i++) {
      const material = input(i);
      if (!allNew && i >= 980 && i < 990) material.title += " updated";
      const result = await upsertMaterial(material, db as unknown as Db);
      if (result.created) counts.created++;
      else if (result.revised) counts.revised++;
      else counts.unchanged++;
    }
    const durationMs = performance.now() - started;
    const cpuDelta = process.cpuUsage(cpu);
    assert.deepEqual(counts, allNew ? { unchanged: 0, created: 1000, revised: 0 } : { unchanged: 980, created: 10, revised: 10 });
    const measurement = { run, warmup: run === 0, durationMs, clientCpuMs: (cpuDelta.user + cpuDelta.system) / 1000, queries, counts };
    results.push(measurement);
    // Fresh identities each run prevent prior revisions from changing the fixture mix.
    await db`DELETE FROM articles WHERE source_id = ${source}`;
    await db`DELETE FROM sources WHERE id = ${source}`;
  }
  console.log(JSON.stringify({ baseline, baselineRef: baseline ? baselineRef : null, node: process.version, fixture: allNew ? "1000 new" : "980 unchanged / 10 new / 10 modified", results }, null, 2));
} finally {
  await db.end();
  await closeDb();
  if (baseline) unlinkSync(temporaryModule);
}
