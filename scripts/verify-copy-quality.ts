// Explicit, receipt-backed model regression replay. Does not publish or create articles.
// node --env-file=.env scripts/verify-copy-quality.ts --input .data/local-quality/cases.json --output .data/local-quality/replay.json --allow-model-calls
// Original P5 source text was NOT checked into reference/trials; reconstructed examples must say so.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" }, "allow-model-calls": { type: "boolean", default: false }, "complete-saved": { type: "string" } } });
// A durable accepted replay is the script's business result. Finish only its matching received
// responses; failed/rejected outputs stay failed. This mode performs no model call.
async function completeSaved(file: string) {
  const artifact = JSON.parse(readFileSync(resolve(file), "utf8"));
  if (artifact.humanLabels !== 0 || !Array.isArray(artifact.cases) || !artifact.runId) throw new Error("Not a copy replay artifact");
  const expected = artifact.cases.filter((row: any) => row.result?.status === "accepted-by-automatic-guards")
    .flatMap((row: any) => row.receipts ?? []).filter((row: any) => Number.isSafeInteger(row.id) && row.response);
  const { sql, closeDb } = await import("@aihot/backend/db");
  const { completeReceipt } = await import("@aihot/backend/providers/receipts");
  const { stableJson } = await import("@aihot/backend/lib/ids");
  let completed = 0;
  try {
    await sql.begin(async tx => {
      const rows = await tx`SELECT id,response FROM receipts WHERE id=ANY(${expected.map((row: any) => row.id)}::bigint[]) AND status='received' FOR UPDATE`;
      for (const row of rows) {
        if (!expected.some((saved: any) => saved.id === Number(row.id) && stableJson(saved.response) === stableJson(row.response))) throw new Error(`Saved response mismatch for receipt ${row.id}`);
        await completeReceipt(tx, Number(row.id)); completed++;
      }
    });
  } finally { await closeDb(); }
  return completed;
}
if (values["complete-saved"]) {
  if (values.input || values.output || values["allow-model-calls"]) throw new Error("--complete-saved is a separate, model-free mode");
  console.log(JSON.stringify({ completed: await completeSaved(values["complete-saved"]), modelCalls: 0 }));
  process.exit(0);
}
if (!values["allow-model-calls"] || process.env.MODEL_CALLS_ENABLED !== "true") throw new Error("Explicit --allow-model-calls and MODEL_CALLS_ENABLED=true are required");
if (!values.input || !values.output) throw new Error("--input and --output are required");
interface Case {
  caseId: string; provenance: "historical-original" | "reconstructed-regression" | "refetched-source";
  capturedAt: string; sourceUrl: string; sourceName: string; title: string; text: string;
  category: string; bodyStatus?: "ok" | "unconfirmed"; limitation?: string;
}
const cases = JSON.parse(readFileSync(resolve(values.input), "utf8")) as Case[];
if (!Array.isArray(cases) || !cases.length || cases.length > 20) throw new Error("Expected 1–20 explicit cases");
for (const row of cases) {
  if (!row.caseId || !["historical-original", "reconstructed-regression", "refetched-source"].includes(row.provenance) || !Number.isFinite(Date.parse(row.capturedAt)) || !row.title || !row.text || !row.category || !row.sourceUrl) throw new Error("Each case needs source material, provenance, capture date and category");
}
const { runAnalysis, normalizeAnalysis } = await import("@aihot/backend/editorial/analyze");
const { sql, closeDb } = await import("@aihot/backend/db");
const { stopBoss } = await import("@aihot/backend/jobs/queue");
const { ModelOutputError } = await import("@aihot/backend/providers/llm");
const runId = new Date().toISOString();
const results: unknown[] = [];
const output = resolve(values.output);
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
const save = () => writeFileSync(output, JSON.stringify({ runId, humanLabels: 0, scope: "Model regression replay; not historical input replay unless provenance says historical-original; not human accuracy", cases: results }, null, 2), { mode: 0o600, flush: true });
try {
  for (const row of cases) {
    const articleId = `copy-replay:${runId}:${row.caseId}`;
    let result: unknown;
    const receiptIds = new Set<number>();
    const collectReceipts = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(collectReceipts);
      else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
        if (key === "receiptId" && typeof child === "number") receiptIds.add(child);
        else if (key === "receiptIds" && Array.isArray(child)) child.forEach(id => { if (typeof id === "number") receiptIds.add(id); });
        else collectReceipts(child);
      }
    };
    try {
      const run = await runAnalysis({ id: articleId, revision: 1, title: row.title, bodyText: row.bodyStatus === "unconfirmed" ? null : row.text,
        excerpt: row.bodyStatus === "unconfirmed" ? row.text : null, bodyStatus: row.bodyStatus ?? "ok", url: row.sourceUrl,
        author: null, publishedAt: new Date(row.capturedAt), xPost: null, media: [], manualCategory: row.category,
        source: { name: row.sourceName, kind: "rss", tier: "T1", firstParty: false } }, { attemptTag: "quality-replay" });
      collectReceipts(run);
      result = { status: "accepted-by-automatic-guards", analysis: normalizeAnalysis(run), rawRun: run };
    } catch (error) {
      if (error instanceof ModelOutputError && error.receiptId !== null) receiptIds.add(error.receiptId);
      result = { status: error instanceof ModelOutputError ? "rejected-by-automatic-guards" : "failed", reason: (error as Error).message };
    }
    // Raw provider responses and request/response model fields remain locally reviewable in receipts.
    const receipts = await sql`SELECT id,service,purpose,model,status,request,response,error,usage,cost,currency FROM receipts WHERE id = ANY(${[...receiptIds]}::bigint[]) OR subject LIKE ${`article:${articleId}%`} ORDER BY id`;
    results.push({ input: row, result, receipts });
    save(); // fsync before consuming any received response; a failed save must leave recovery possible.
    const { completeReceipt } = await import("@aihot/backend/providers/receipts");
    if ((result as { status: string }).status === "accepted-by-automatic-guards") {
      await sql.begin(async tx => {
        const received = await tx`SELECT id FROM receipts WHERE id=ANY(${receipts.map(r => Number(r.id))}::bigint[]) AND status='received' FOR UPDATE`;
        for (const row of received) await completeReceipt(tx, Number(row.id));
      });
    }
  }
} finally { save(); await stopBoss(); await closeDb(); }
console.log(JSON.stringify({ output, cases: results.length, humanLabels: 0 }));
