import { randomUUID } from "node:crypto";
import { newsSources } from "../src/config/sources.js";
import { defaultSourceIntervalMinutes } from "../src/lib/sourceCoverage.js";
import { hashCandidates, hashReportContent } from "./newsRefresh.js";
import { getDefaultNewsStore } from "./newsStoreFactory.js";
import { newestContentTimestamp } from "./newsStore.js";
import { expandLegacyItems, readBundledReport } from "./reportStore.js";

async function main() {
  const store = getDefaultNewsStore();
  if (!store?.persistent) throw new Error("Supabase NewsStore is not configured.");

  const existing = await store.readState();
  if (existing.latest) {
    console.log(`Supabase already has a latest report (${existing.latest.reportId}); bootstrap skipped.`);
    return;
  }

  const report = readBundledReport();
  const observedAt = new Date().toISOString();
  const ownerId = randomUUID();
  const lease = await store.tryAcquireRefresh({
    ownerId,
    idempotencyKey: `bootstrap:${report.generatedAt}`,
    trigger: "manual",
    scheduledAt: observedAt,
    leaseSeconds: 120,
  });
  if (!lease.acquired) throw new Error(`Bootstrap lease was not acquired (${lease.outcome}).`);

  const identity = { ownerId, runId: lease.runId, fencingToken: lease.fencingToken };
  const candidates = expandLegacyItems(report.items);
  let publication;
  try {
    await store.syncSources(
      identity,
      newsSources.map((source) => ({
        sourceId: source.source_id,
        enabled: source.enabled,
        intervalMinutes: defaultSourceIntervalMinutes,
      })),
      observedAt,
    );
    await store.upsertCandidates(identity, candidates);
    publication = await store.publishRefresh({
      ...identity,
      reportId: randomUUID(),
      report,
      dataAsOf: report.generatedAt,
      newestContentAt: newestContentTimestamp(report),
      contentHash: hashReportContent(report),
      inputFingerprint: hashCandidates(candidates),
      metrics: { trigger: "bootstrap", candidate_count: candidates.length },
    });
    if (!publication.published && !publication.reportId) throw new Error("Bootstrap report was not published.");
  } catch (error) {
    await store.markRefreshFailed(identity, "bootstrap_failed", {
      trigger: "bootstrap",
      candidate_count: candidates.length,
    }).catch(() => undefined);
    throw error;
  }

  console.log(`Bootstrapped Supabase with report ${publication.reportId ?? publication.previousReportId}.`);
}

main().catch((error) => {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : String(error);
  console.error(code);
  process.exitCode = 1;
});
