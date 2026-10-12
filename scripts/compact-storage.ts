// Preview by default. --apply runs bounded terminal-data cleanup, never VACUUM FULL or paid calls.
import { parseArgs } from "node:util";
import { sql, closeDb } from "@aihot/backend/db";
import { hourlyRetention } from "@aihot/backend/operations/retention";
import { receiptCompressionEnabled } from "@aihot/backend/providers/receipt-storage";

const { values } = parseArgs({ options: {
  apply: { type: "boolean", default: false },
  "max-batches": { type: "string", default: "1" },
} });
const batches = Number(values["max-batches"]);
if (!Number.isInteger(batches) || batches < 1 || batches > 500) throw new Error("--max-batches must be 1..500");

async function inspect() {
  const [database] = await sql`SELECT current_database() AS name, pg_database_size(current_database())::bigint AS bytes`;
  const relations = await sql`SELECT schemaname || '.' || relname AS relation, pg_total_relation_size(relid)::bigint AS bytes
    FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10`;
  const [eligible] = await sql`
    SELECT (SELECT count(*) FROM collection_items WHERE completed_at IS NOT NULL AND (candidate<>'{}'::jsonb OR need IS NOT NULL))::int AS completed_payloads,
      (SELECT count(*) FROM collection_intakes r JOIN fetch_runs f ON f.id=r.run_id
       WHERE r.finished_at < now()-interval '1 hour' AND f.finished_at IS NOT NULL AND f.status<>'running'
       AND NOT EXISTS(SELECT 1 FROM collection_batches b JOIN collection_items i ON i.batch_id=b.id
         WHERE b.run_id=r.run_id AND i.completed_at IS NULL))::int AS completed_intakes,
      (SELECT count(*) FROM receipts WHERE status='completed' AND NOT response_storage_checked)::int AS unchecked_receipts`;
  const [queue] = await sql`SELECT to_regclass('pgboss.job') IS NOT NULL AS ready`;
  const [jobs] = queue!.ready ? await sql`SELECT count(*)::int AS expired_terminal_jobs FROM pgboss.job
    WHERE (state='completed' AND completed_on<now()-interval '1 day')
       OR (state IN ('failed','cancelled') AND completed_on<now()-interval '7 days')` : [{ expired_terminal_jobs: 0 }];
  return { database, relations, eligible: { ...eligible, ...jobs }, receiptCompressionEnabled: receiptCompressionEnabled() };
}

try {
  const before = await inspect();
  const totals: Record<string, number> = {};
  let completedBatches = 0;
  if (values.apply) {
    const now = new Date();
    for (let n = 0; n < batches; n++) {
      const result = await hourlyRetention(now);
      completedBatches++;
      for (const [key, value] of Object.entries(result)) totals[key] = (totals[key] ?? 0) + value;
      if (result.checkedReceipts + result.compactedCollectionItems + result.deletedCollectionIntakes + result.deletedQueueJobs === 0) break;
    }
  }
  console.log(JSON.stringify({ mode: values.apply ? "apply" : "dry-run", completedBatches, totals, before,
    after: values.apply ? await inspect() : null,
    note: "Deleted/compacted rows release reusable space; physical database bytes may not shrink until separately reclaimed." }, null, 2));
} finally { await closeDb(); }
