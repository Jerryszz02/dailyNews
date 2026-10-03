import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { selectedChanges, selectedSnapshot, v1Items } from "@aihot/backend/publication/v1";

const source = `ledger-contract-${randomUUID()}`;
after(async () => { await stopBoss(); await closeDb(); });

test("pre-P4 selected ledger payloads receive explicit null metadata without changing the current item projection", async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES(${source},'旧账本契约测试','rss','T1','editorial','2100-01-01')`;
  // Other invariant files may leave selected entries waiting behind a release gate. Read after
  // the latest existing gate instead of editing their ledger rows or depending on test order.
  const [gate] = await sql<{ latest: Date | null }[]>`SELECT max(visible_at) AS latest FROM selected_ledger`;
  const readAt = new Date(Math.max(Date.now(), gate?.latest?.getTime() ?? 0) + 1000);
  const before = await selectedSnapshot({ limit: 1000, page: null, fields: "default" }, readAt);
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.com/${source}`,
    title: "测试旧账本字段", bodyText: "足够的离线测试正文。", bodyStatus: "ok", via: "ingest", publishedAt: new Date() });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES(${articleId},1,'rule','pass','ai','测试旧账本字段','旧记录仍需稳定公开。',72,true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });

  const modern = await selectedChanges({ cursor: before.cursor, limit: 1000 }, readAt);
  const modernItem = modern.changes.find((change) => change.op === "upsert" && change.item.id === articleId);
  assert.equal(modernItem?.op === "upsert" && modernItem.item.scoreKind, "ai_attention", "new ledger values pass through");

  const [entry] = await sql<{ seq: number }[]>`
    SELECT max(seq)::int AS seq FROM selected_ledger WHERE article_id=${articleId} AND op='upsert'`;
  assert.ok(entry?.seq);
  await sql`UPDATE selected_ledger SET payload=payload - ARRAY['scoreKind','importanceTier','factStatus']::text[] WHERE seq=${entry!.seq}`;
  const [stored] = await sql<{ has_kind: boolean; has_tier: boolean; has_status: boolean }[]>`
    SELECT payload ? 'scoreKind' AS has_kind, payload ? 'importanceTier' AS has_tier,
      payload ? 'factStatus' AS has_status FROM selected_ledger WHERE seq=${entry!.seq}`;
  assert.deepEqual(stored, { has_kind: false, has_tier: false, has_status: false }, "the fixture remains pre-P4 on disk");

  const full = await selectedSnapshot({ limit: 1000, page: null, fields: "default" }, readAt);
  const minimal = await selectedSnapshot({ limit: 1000, page: null, fields: "minimal" }, readAt);
  const changes = await selectedChanges({ cursor: before.cursor, limit: 1000 }, readAt);
  for (const item of [full.items.find((i) => i.id === articleId), minimal.items.find((i) => i.id === articleId),
    changes.changes.find((change) => change.op === "upsert" && change.item.id === articleId)?.item]) {
    assert.ok(item);
    assert.deepEqual({ scoreKind: item.scoreKind, importanceTier: item.importanceTier, factStatus: item.factStatus },
      { scoreKind: null, importanceTier: null, factStatus: null });
    assert.equal(item.score, 72, "the historical score remains unchanged and does not imply its policy");
  }
  const current = await v1Items({ mode: "selected", window: "7d", by: "published", category: "ai", q: null, limit: 100, cursor: null });
  assert.equal(current.items.find((item) => item.id === articleId)?.scoreKind, "ai_attention",
    "items reads the current publication projection independently of historical ledger JSON");
});

test("OpenAPI documents required nullable metadata for full and minimal items", () => {
  const doc = JSON.parse(readFileSync(new URL("../reference/public-v1.openapi.json", import.meta.url), "utf8"));
  assert.equal(doc.info.version, "2.2.0");
  for (const name of ["Item", "ItemMinimal"]) {
    const schema = doc.components.schemas[name];
    for (const field of ["scoreKind", "importanceTier", "factStatus"]) {
      assert(schema.required.includes(field));
      assert(schema.properties[field].type.includes("null"));
    }
    assert.match(schema.properties.score.description, /same non-null scoreKind/);
  }
});
