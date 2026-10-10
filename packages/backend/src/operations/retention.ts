// Daily housekeeping: expired leases, old run history, files past their life and derived caches.
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";

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
  // Keep raw listing handoffs one day after completion. Recovery state always survives,
  // including an inconsistent finished intake that still owns an unfinished tail item.
  const collectionIntakes = await sql`
    DELETE FROM collection_intakes r
    WHERE r.finished_at < ${new Date(now.getTime() - 24 * 3600_000)}
      AND NOT EXISTS (
        SELECT 1 FROM collection_batches b JOIN collection_items i ON i.batch_id = b.id
        WHERE b.run_id = r.run_id AND i.completed_at IS NULL
      )`;
  // Raw files with a bounded life.
  const files = await sql<{ key: string }[]>`DELETE FROM stored_files WHERE expires_at < ${now} RETURNING key`;
  for (const f of files) await unlink(path.join(config.dataDir, f.key)).catch(() => {});
  const monthMs = 30 * 86400_000;
  const prunedCache = (await pruneCache(path.join(config.dataDir, "imgcache"), monthMs, now.getTime())) + (await pruneCache(path.join(config.dataDir, "ogcache"), monthMs, now.getTime()));
  return { deletedLeases: leases.count, deletedJobRuns: runs.count, deletedFiles: files.length, deletedCollectionIntakes: collectionIntakes.count, prunedCache };
}
