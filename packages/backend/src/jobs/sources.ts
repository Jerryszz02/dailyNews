// Collection jobs: per-source fetch runs and body extraction before analysis.
import type { PgBoss } from "pg-boss";
import { collectSource, collectXShard } from "../sources/collect.ts";
import { checkMpAccount } from "../sources/mp.ts";
import { QUEUES, work } from "./queue.ts";
import { registerExtractionJobs } from "./content.ts";

export async function registerSourceJobs(boss: PgBoss) {
  const boundedTrial = process.env.DAILYNEWS_TRIAL_MODE === "bounded";
  await work(boss, QUEUES.fetchSource, { localConcurrency: boundedTrial ? 4 : Number(process.env.FETCH_CONCURRENCY || 8), pollingIntervalSeconds: 2 }, async (data) => {
    return collectSource(data.sourceId, { force: data.force });
  });
  // One search per shard of X accounts; the SocialData per-minute budget is shared with the reset monitor.
  await work(boss, QUEUES.fetchXShard, { localConcurrency: 2, pollingIntervalSeconds: 2 }, async (data) => {
    if (boundedTrial) return { status: "skipped", reason: "bounded trial does not admit X shard jobs" };
    return collectXShard(data.key, data.sourceIds);
  });
  // Dajiala allows a few requests per second; two accounts at a time stays well under it.
  await work(boss, QUEUES.mpCheck, { localConcurrency: 2, pollingIntervalSeconds: 2 }, async (data) => {
    if (boundedTrial) return { status: "skipped", reason: "bounded trial does not admit MP jobs" };
    return checkMpAccount(data.sourceId, data.reason ?? "schedule");
  });
  await registerExtractionJobs(boss);
}
