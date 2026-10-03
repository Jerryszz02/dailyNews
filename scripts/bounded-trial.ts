// An explicit, fixed-cohort local trial. Importing this module has no collection side effects.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import type { SourceRow } from "@aihot/backend/sources/types";

export interface TrialManifest {
  id: string;
  sourceIds: string[];
  maxNormal: 100;
  maxHistorical: 20;
  collectionConcurrency: 4;
  modelConcurrency: 2;
  modelBudget: { perMinute: 20; perHour: 200; perDay: 1000 };
}

const SOURCE_ID = /^[a-z0-9][a-z0-9_-]{2,99}$/;
const TRIAL_ID = /^[a-z0-9][a-z0-9_-]{2,79}$/;

export function validateManifest(value: unknown): TrialManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("trial manifest must be an object");
  const m = value as Record<string, unknown>;
  if (typeof m.id !== "string" || !TRIAL_ID.test(m.id)) throw new Error("trial id is missing or invalid");
  if (!Array.isArray(m.sourceIds) || m.sourceIds.length < 10 || m.sourceIds.length > 15
    || m.sourceIds.some((id) => typeof id !== "string" || !SOURCE_ID.test(id))
    || new Set(m.sourceIds).size !== m.sourceIds.length) throw new Error("trial requires 10–15 distinct source IDs");
  if (m.maxNormal !== 100 || m.maxHistorical !== 20 || m.collectionConcurrency !== 4 || m.modelConcurrency !== 2)
    throw new Error("trial limits must be 100 normal, 20 historical, collect 4 and model 2");
  const b = m.modelBudget;
  if (!b || typeof b !== "object" || Array.isArray(b)
    || (b as Record<string, unknown>).perMinute !== 20 || (b as Record<string, unknown>).perHour !== 200
    || (b as Record<string, unknown>).perDay !== 1000 || Object.keys(b).some((key) => !["perMinute", "perHour", "perDay"].includes(key)))
    throw new Error("trial model budget must be 20/min, 200/hour and 1000/day");
  const allowed = ["id", "sourceIds", "maxNormal", "maxHistorical", "collectionConcurrency", "modelConcurrency", "modelBudget"];
  if (Object.keys(m).some((key) => !allowed.includes(key))) throw new Error("trial manifest has unsupported fields");
  return m as unknown as TrialManifest;
}

/** At most `limit` in flight, without starting another source after an error. */
export async function mapBounded<T, R>(items: readonly T[], limit: number, visit: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("invalid concurrency");
  const result: R[] = Array(items.length);
  let next = 0;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && failure === undefined) {
      const index = next++;
      try { result[index] = await visit(items[index]!); }
      catch (error) { failure = error; }
    }
  }));
  if (failure !== undefined) throw failure;
  return result;
}

// Command implementation is deliberately below the pure helpers; the CLI never runs on import.
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    manifest: { type: "string" }, id: { type: "string" }, date: { type: "string" }, output: { type: "string" },
  } });
  const command = positionals[0];
  if (!command || !["init", "status", "collect", "daily", "freeze", "close", "report"].includes(command) || positionals.length !== 1)
    throw new Error("usage: bounded-trial.ts init|status|collect|daily|freeze|close|report [--id ID] [--date YYYY-MM-DD] [--manifest FILE] [--output FILE]");
  try {
    const dedicated = process.env.DAILYNEWS_TRIAL_DB_NAME;
    if (!dedicated || !/^[a-zA-Z0-9_]+_(?:trial|test|ci)$/.test(dedicated))
      throw new Error("DAILYNEWS_TRIAL_DB_NAME must name an isolated *_trial, *_test or *_ci database");
    const [database] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
    if (database?.name !== dedicated) throw new Error(`database mismatch: expected ${dedicated}`);
    if (command === "init") {
      if (!values.manifest || values.id) throw new Error("init requires --manifest and no --id");
      const manifest = validateManifest(JSON.parse(readFileSync(values.manifest, "utf8")));
      // The caller supplies reviewed, verified source IDs; source admission is never guessed here.
      const rows = await sql<{ id: string; kind: SourceRow["kind"]; config: SourceRow["config"];
        enabled: boolean; status: string | null }[]>`
        SELECT id, kind, config, enabled, config #>> '{dailyNews,migrationStatus}' AS status
        FROM sources WHERE id = ANY(${manifest.sourceIds}::text[])`;
      if (rows.length !== manifest.sourceIds.length || rows.some((row) => !row.enabled || row.status !== "verified"
        || unsupportedConfig(row.kind, row.config).length > 0))
        throw new Error("every manifest source must exist, be enabled and have verified collector config");
      const adapters = new Set(rows.map((row) => row.config.dailyNews?.adapter));
      if (!["rss", "web_list", "sitemap"].every((adapter) => adapters.has(adapter)))
        throw new Error("trial source manifest must include RSS, web-list and sitemap adapters");
      const budgets = await sql<{ service: string; per_minute: number; per_hour: number; per_day: number }[]>`
        SELECT service,per_minute,per_hour,per_day FROM budgets WHERE service IN ('deepseek','llm-global')`;
      if (budgets.length !== 2 || budgets.some((row) => row.per_minute !== manifest.modelBudget.perMinute
        || row.per_hour !== manifest.modelBudget.perHour || row.per_day !== manifest.modelBudget.perDay))
        throw new Error("deepseek and llm-global budgets must match the fixed manifest before init");
      const { createTrial } = await import("@aihot/backend/dailynews/trial");
      const created = await createTrial({ id: manifest.id, sourceIds: manifest.sourceIds,
        normalLimit: manifest.maxNormal, backfillLimit: manifest.maxHistorical }, sql);
      console.log(JSON.stringify({ id: created.id, status: created.status, sourceCount: rows.length,
        manifestHash: created.manifestHash, settingsHash: created.settingsHash }));
      return;
    }
    if (!values.id || !TRIAL_ID.test(values.id)) throw new Error(`${command} requires --id`);
    const [trial] = await sql<{ id: string; status: string; settings_hash: string }[]>`
      SELECT id,status,settings_hash FROM dailynews_trials WHERE id=${values.id}`;
    if (!trial) throw new Error(`unknown trial ${values.id}`);
    if (command === "status" || command === "report") {
      const { trialReport } = await import("./bounded-trial-report.ts");
      const report = await trialReport(values.id);
      const json = JSON.stringify(report, null, 2) + "\n";
      if (values.output) writeFileSync(values.output, json, { flag: "w" });
      else process.stdout.write(json);
      return;
    }
    if (command === "freeze" || command === "close") {
      const { freezeTrial, closeTrial } = await import("@aihot/backend/dailynews/trial");
      await (command === "freeze" ? freezeTrial : closeTrial)(values.id, sql);
      console.log(JSON.stringify({ id: values.id, status: command === "freeze" ? "frozen" : "closed" }));
      return;
    }
    // Collection and an explicitly due daily edition can touch a network. Both require the
    // same active fixed trial; neither command starts recurring schedules.
    if (trial.status !== "open") throw new Error(`trial ${values.id} is ${trial.status}`);
    process.env.DAILYNEWS_TRIAL_MODE = "bounded";
    process.env.DAILYNEWS_TRIAL_ID = values.id;
    process.env.DAILYNEWS_TRIAL_SETTINGS_HASH = trial.settings_hash;
    const { assertTrialRuntime } = await import("@aihot/backend/dailynews/trial");
    await assertTrialRuntime(sql);
    if (command === "daily") {
      const date = values.date;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
        throw new Error("daily requires a valid --date YYYY-MM-DD");
      const { assertTrialReportDue, composeDaily } = await import("@aihot/backend/reports/compose");
      assertTrialReportDue("daily", date);
      const { admitTrialReportKey } = await import("@aihot/backend/dailynews/trial");
      await admitTrialReportKey("daily", date);
      console.log(JSON.stringify(await composeDaily(date, "bounded-trial")));
      return;
    }
    const sources = await sql<{ source_id: string }[]>`
      SELECT source_id FROM dailynews_trial_sources WHERE trial_id=${values.id} ORDER BY source_id`;
    const { collectSource } = await import("@aihot/backend/sources/collect");
    const results = await mapBounded(sources.map((s) => s.source_id), 4,
      (sourceId) => collectSource(sourceId, { force: true, trialId: values.id }));
    console.log(JSON.stringify({ id: values.id, results }, null, 2));
  } finally {
    await stopBoss();
    await closeDb();
  }
}

if (import.meta.main) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
