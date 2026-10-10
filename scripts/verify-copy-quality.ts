// Explicit, receipt-backed model regression replay. Does not publish or create articles.
// node --env-file=.env scripts/verify-copy-quality.ts --input .data/local-quality/cases.json --output .data/local-quality/replay.json --allow-model-calls
// Original P5 source text was NOT checked into reference/trials; reconstructed examples must say so.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" }, "allow-model-calls": { type: "boolean", default: false } } });
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
const save = () => writeFileSync(output, JSON.stringify({ runId, humanLabels: 0, scope: "Model regression replay; not historical input replay unless provenance says historical-original; not human accuracy", cases: results }, null, 2), { mode: 0o600 });
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
    results.push({ input: row, result, receipts }); save();
  }
} finally { save(); await stopBoss(); await closeDb(); }
console.log(JSON.stringify({ output, cases: results.length, humanLabels: 0 }));
