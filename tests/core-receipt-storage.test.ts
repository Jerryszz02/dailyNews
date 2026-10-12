import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { sql, closeDb } from "@aihot/backend/db";
import { paidRequest, completeReceipt, logicalKeyFor, compactCompletedReceiptResponses } from "@aihot/backend/providers/receipts";
import { decodeReceiptResponse } from "@aihot/backend/providers/receipt-storage";

after(closeDb);
process.env.RECEIPT_COMPRESSION_ENABLED = "true";

test("compressed received and completed answers replay without a second charge; retries replace storage", async () => {
  const service = `storage-${tag()}`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${service},10,10,10)`;
  const req = { service, purpose: "storage-regression", identity: tag() };
  const response = { choices: [{ text: "完整中文新闻响应，保留原文和证据。".repeat(1000) }], nested: [null, false, 1] };
  let sent = 0;
  const call = async () => { sent++; return { response, usage: { prompt_tokens: 12, completion_tokens: 34 },
    cost: { amount: 0.001, currency: "USD", basis: "actual" as const } }; };
  const first = await paidRequest(req, call);
  const [stored] = await sql`SELECT response,response_compressed,prompt_tokens,completion_tokens,cost FROM receipts WHERE id=${first.receiptId}`;
  assert.equal(stored!.response, null);
  assert.ok(stored!.response_compressed instanceof Uint8Array);
  assert.deepEqual((await paidRequest(req, call)).response, response);
  await completeReceipt(sql, first.receiptId);
  assert.deepEqual((await paidRequest(req, call)).response, response);
  assert.equal(sent, 1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id=${first.receiptId}`)[0]!.n, 1);
  assert.deepEqual([stored!.prompt_tokens, stored!.completion_tokens, stored!.cost], [12, 34, 0.001]);
  // A rejected saved answer may be deliberately retried. A small new response clears old gzip.
  await sql`UPDATE receipts SET status='failed' WHERE id=${first.receiptId}`;
  const small = await paidRequest(req, async () => ({ response: { ok: true } }));
  assert.deepEqual(small.response, { ok: true });
  const [replaced] = await sql`SELECT response,response_compressed FROM receipts WHERE id=${first.receiptId}`;
  assert.deepEqual(replaced!.response, { ok: true });
  assert.equal(replaced!.response_compressed, null);
});

test("legacy JSON and valid null responses remain reusable without provider calls", async () => {
  for (const response of [null, { ok: true, unicode: "中文" }]) {
    const req = { service: "offline-storage", purpose: "storage-regression", identity: tag() };
    await sql`INSERT INTO receipts(logical_key,service,purpose,status,response)
      VALUES(${logicalKeyFor(req)},${req.service},${req.purpose},'received',${sql.json(response)})`;
    const result = await paidRequest(req, async () => { throw new Error("must not call provider"); });
    assert.equal(result.reused, true);
    assert.deepEqual(result.response, response);
  }
});

test("a corrupted compressed answer fails without changing state or creating paid attempts", async () => {
  const req = { service: "offline-storage", purpose: "storage-regression", identity: tag() };
  const [row] = await sql`INSERT INTO receipts(logical_key,service,purpose,status,response_compressed)
    VALUES(${logicalKeyFor(req)},${req.service},${req.purpose},'received',${Buffer.from("broken gzip")}) RETURNING id`;
  let sent = 0;
  await assert.rejects(paidRequest(req, async () => { sent++; return { response: "unexpected" }; }), /cannot be decoded/);
  assert.equal(sent, 0);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${row!.id}`)[0]!.status, "received");
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id=${row!.id}`)[0]!.n, 0);
});

test("bounded backfill shrinks only completed receipts and preserves billing, nulls and replay", async () => {
  const marker = `backfill-${tag()}`;
  const response = { body: "中文".repeat(200) };
  const ids: number[] = [];
  for (let n = 0; n < 105; n++) {
    const [row] = await sql`INSERT INTO receipts(logical_key,service,purpose,status,response,cost,completed_at)
      VALUES(${`${marker}-${n}`},${marker},'storage-regression','completed',${sql.json(n === 0 ? null : response)},0.001,now()) RETURNING id`;
    ids.push(Number(row!.id));
  }
  for (const status of ["received", "unknown", "pending", "failed"]) {
    await sql`INSERT INTO receipts(logical_key,service,purpose,status,response)
      VALUES(${`${marker}-${status}`},${marker},'storage-regression',${status},${sql.json(response)})`;
  }
  const snapshot = await sql`SELECT id,status,cost,updated_at,completed_at FROM receipts WHERE id IN ${sql(ids)} ORDER BY id`;
  let compressed = 0;
  let before = 0;
  let after = 0;
  for (let n = 0; n < 100; n++) {
    const result = await compactCompletedReceiptResponses();
    assert.ok(result.checkedReceipts <= 100);
    compressed += result.compressedReceipts;
    before += result.receiptBytesBefore;
    after += result.receiptBytesAfter;
    if (!result.checkedReceipts) break;
    assert.notEqual(n, 99, "backfill must terminate");
  }
  assert.ok(compressed >= 104);
  assert.ok(after < before);
  assert.deepEqual(await sql`SELECT id,status,cost,updated_at,completed_at FROM receipts WHERE id IN ${sql(ids)} ORDER BY id`, snapshot);
  const rows = await sql`SELECT id,response,response_compressed,response_storage_checked FROM receipts WHERE id IN ${sql(ids)} ORDER BY id`;
  for (let n = 0; n < rows.length; n++) {
    const row = rows[n]!;
    assert.equal(row.response_storage_checked, true);
    assert.deepEqual(decodeReceiptResponse({ response: row.response, response_compressed: row.response_compressed }), n === 0 ? null : response);
  }
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE service=${marker} AND status<>'completed' AND NOT response_storage_checked`)[0]!.n, 4);
  assert.equal((await compactCompletedReceiptResponses()).checkedReceipts, 0);
});

test("backfill preserves large JSON numbers exactly, and the rollout gate leaves legacy readers compatible", async () => {
  const service = `storage-gate-${tag()}`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES(${service},10,10,10)`;
  process.env.RECEIPT_COMPRESSION_ENABLED = "false";
  try {
    const response = { text: "完整响应。".repeat(100) };
    const result = await paidRequest({ service, purpose: "storage-regression", identity: tag() }, async () => ({ response }));
    const [plain] = await sql`SELECT response,response_compressed,response_storage_checked FROM receipts WHERE id=${result.receiptId}`;
    assert.deepEqual(plain!.response, response);
    assert.equal(plain!.response_compressed, null);
    assert.equal(plain!.response_storage_checked, false);
    await completeReceipt(sql, result.receiptId);
    assert.equal((await compactCompletedReceiptResponses()).checkedReceipts, 0);
  } finally { process.env.RECEIPT_COMPRESSION_ENABLED = "true"; }
  const raw = `{"integer":9007199254740993,"decimal":0.1234567890123456789,"text":"${"x".repeat(1200)}"}`;
  const [row] = await sql`INSERT INTO receipts(logical_key,service,purpose,status,response)
    VALUES(${tag()},${service},'storage-regression','completed',${raw}::text::jsonb) RETURNING id,response::text AS original`;
  await compactCompletedReceiptResponses();
  const [packed] = await sql`SELECT response_compressed FROM receipts WHERE id=${row!.id}`;
  assert.ok(packed!.response_compressed);
  assert.equal(gunzipSync(packed!.response_compressed).toString("utf8"), row!.original);
});
