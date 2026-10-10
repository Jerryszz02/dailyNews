import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';

const dir = mkdtempSync(path.join(tmpdir(), 'copy-replay-completion-'));
after(async () => { rmSync(dir, { recursive: true }); await closeDb(); });
const complete = (file: string) => spawnSync(process.execPath, ['scripts/verify-copy-quality.ts', '--complete-saved', file], {
  encoding: 'utf8', env: { ...process.env, MODEL_CALLS_ENABLED: 'false' },
});

test('durably saved accepted replay consumes matching received responses without model calls; mismatches roll back', async () => {
  const marker = tag();
  const response = { id: `synthetic-${marker}`, model: 'offline-model', choices: [] };
  const [accepted] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,status,response) VALUES(${`completion-accepted-${marker}`},'offline','quality-replay','received',${sql.json(response)}) RETURNING id`;
  const [rejected] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,status,response,error) VALUES(${`completion-rejected-${marker}`},'offline','quality-replay','failed',${sql.json(response)},'evidence rejection') RETURNING id`;
  const file = path.join(dir, 'artifact.json');
  const artifact = (savedResponse: unknown) => ({ humanLabels: 0, runId: marker, cases: [
    { result: { status: 'accepted-by-automatic-guards' }, receipts: [{ id: Number(accepted!.id), response: savedResponse }] },
    { result: { status: 'rejected-by-automatic-guards' }, receipts: [{ id: Number(rejected!.id), response }] },
  ] });
  writeFileSync(file, JSON.stringify(artifact({ ...response, id: 'wrong-output' })), { flush: true });
  assert.notEqual(complete(file).status, 0);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${accepted!.id}`)[0]!.status, 'received');
  writeFileSync(file, JSON.stringify(artifact(response)), { flush: true });
  const first = complete(file);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { completed: 1, modelCalls: 0 });
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${accepted!.id}`)[0]!.status, 'completed');
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${rejected!.id}`)[0]!.status, 'failed');
  const repeated = complete(file);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout), { completed: 0, modelCalls: 0 });
});
