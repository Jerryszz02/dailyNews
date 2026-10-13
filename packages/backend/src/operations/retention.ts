// Daily housekeeping: expired leases, old run history, files past their life and derived caches.
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { compactCompletedReceiptResponses } from "../providers/receipts.ts";

/** Derived caches (proxied images, share cards and posters) are rebuilt on demand; drop ones older than a month. */
async function pruneCache(dir: string, maxAgeMs: number, now: number): Promise<number> {
  let removed = 0;
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      const info = await stat(p).catch(() => null);
      if (info && now - info.mtimeMs > maxAgeMs) {
        await unlink(p).catch(() => {});
        removed += 1;
      }
    }
  };
  await walk(dir);
  return removed;
}

export async function dailyRetention(now = new Date()) {
  const leases = await sql`DELETE FROM delivery_leases WHERE expires_at < ${now}`;
  // Scheduled-task history: 30 days (failures 90) is enough for the runs view.
  const runs = await sql`DELETE FROM job_runs WHERE started_at < ${new Date(now.getTime() - 30 * 86400_000)} AND (status IS DISTINCT FROM 'failed' OR started_at < ${new Date(now.getTime() - 90 * 86400_000)})`;
  const shortTerm = await hourlyRetention(now);
  // Raw files with a bounded life.
  const files = await sql<{ key: string }[]>`DELETE FROM stored_files WHERE expires_at < ${now} RETURNING key`;
  for (const f of files) await unlink(path.join(config.dataDir, f.key)).catch(() => {});
  const monthMs = 30 * 86400_000;
  const prunedCache = (await pruneCache(path.join(config.dataDir, "imgcache"), monthMs, now.getTime())) + (await pruneCache(path.join(config.dataDir, "ogcache"), monthMs, now.getTime()));
  return { deletedLeases: leases.count, deletedJobRuns: runs.count, deletedFiles: files.length, ...shortTerm, prunedCache };
}

/** Small, frequent batches release duplicated handoff payloads and successful queue history.
 * Only terminal work is touched: detail retries and unfinished tail items stay recoverable.
 */
export async function hourlyRetention(now = new Date()) {
  const compacted = await sql`
    WITH targets AS (
      SELECT id FROM collection_items
      WHERE completed_at IS NOT NULL AND (candidate <> '{}'::jsonb OR need IS NOT NULL)
      ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED
    )
    UPDATE collection_items i SET candidate='{}'::jsonb,need=NULL,detail_retry_at=NULL,detail_error=NULL
    FROM targets t WHERE i.id=t.id`;
  const intakes = await sql`
    WITH targets AS (
      SELECT r.run_id FROM collection_intakes r JOIN fetch_runs f ON f.id=r.run_id
      WHERE r.finished_at < ${new Date(now.getTime() - 3600_000)}
        AND f.finished_at IS NOT NULL AND f.status <> 'running'
        AND NOT EXISTS (
          SELECT 1 FROM collection_batches b JOIN collection_items i ON i.batch_id=b.id
          WHERE b.run_id=r.run_id AND i.completed_at IS NULL
        )
      ORDER BY r.finished_at LIMIT 200 FOR UPDATE OF r SKIP LOCKED
    )
    DELETE FROM collection_intakes r USING targets t WHERE r.run_id=t.run_id`;
  // pg-boss may not have started in an API-only process. It owns its schema creation.
  const [queue] = await sql`SELECT to_regclass('pgboss.job') IS NOT NULL AS ready`;
  let deletedQueueJobs = 0;
  if (queue!.ready) {
    // Hourly batches also cover reprocessing spikes: up to 120k terminal jobs/day.
    const jobs = await sql`
      WITH targets AS (
        SELECT name,id FROM pgboss.job
        WHERE (state='completed' AND completed_on < ${new Date(now.getTime() - 86400_000)})
          OR (state IN ('failed','cancelled') AND completed_on < ${new Date(now.getTime() - 7 * 86400_000)})
        ORDER BY completed_on LIMIT 5000 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM pgboss.job j USING targets t WHERE j.name=t.name AND j.id=t.id`;
    deletedQueueJobs = jobs.count;
  }
  const receipts = await compactCompletedReceiptResponses();
  return { ...receipts, compactedCollectionItems: compacted.count, deletedCollectionIntakes: intakes.count, deletedQueueJobs };
}
