import './setup.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { publishArticle } from '@aihot/backend/publication/publish';
import { loadItemDetail } from '@aihot/backend/publication/detail';
import { pickRepresentative } from '@aihot/backend/publication/timeline';
import { itemAvailability } from '@aihot/backend/publication/availability';
import { loadItemShare } from '@aihot/backend/publication/og';
import { loadDevelopments } from '@aihot/backend/publication/groups';
import { stopBoss } from '@aihot/backend/jobs/queue';

const source = `p4-contract-${randomUUID()}`;
const stories: number[] = [];
after(async () => {
  if (stories.length) {
    await sql`DELETE FROM facts WHERE story_id=ANY(${stories}::bigint[])`;
    await sql`DELETE FROM stories WHERE id=ANY(${stories}::bigint[])`;
  }
  await sql`DELETE FROM selected_ledger WHERE article_id IN (SELECT id FROM articles WHERE source_id=${source})`;
  await sql`DELETE FROM selected_state WHERE article_id IN (SELECT id FROM articles WHERE source_id=${source})`;
  await sql`DELETE FROM articles WHERE source_id=${source}`;
  await sql`DELETE FROM sources WHERE id=${source}`;
  await stopBoss();
  await closeDb();
});

test('mixed policy representatives use stable time order; same-policy AI retains its score preference', () => {
  const a = { id: 'a', first_party: false, body_mode: 'summary' as const, score: 20,
    score_kind: 'legacy_curation_total' as const, timeline_at: new Date('2026-10-01T01:00:00Z') };
  const b = { ...a, id: 'b', score: 99, score_kind: 'ai_attention' as const, timeline_at: new Date('2026-10-01T02:00:00Z') };
  assert.equal(pickRepresentative([b, a]).id, 'a');
  assert.equal(pickRepresentative([{ ...a, score_kind: 'ai_attention' }, b]).id, 'b');
});

test('first public readiness survives identical publication and resets on material revision', async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES(${source},'公开契约测试','rss','T1','editorial','2100-01-01')`;
  const material = { sourceId: source, url: `https://example.com/${source}`, title: '公开契约验收材料',
    bodyText: '一条有足够正文的离线验收材料。', bodyStatus: 'ok' as const, via: 'ingest' as const };
  const { articleId } = await upsertMaterial(material);
  async function analysis(revision: number, relevance = 'pass') {
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
      VALUES(${articleId},${revision},'rule',${relevance},'ai','公开契约验收材料','离线验收摘要',20,false)`;
  }
  await analysis(1);
  const ready = new Date(Date.now() - 60_000);
  await publishArticle(articleId, { now: ready });
  await publishArticle(articleId);
  assert.equal((await sql<{ public_ready_at: Date }[]>`SELECT public_ready_at FROM publications WHERE article_id=${articleId}`)[0]!.public_ready_at.toISOString(), ready.toISOString());
  assert.equal((await loadItemDetail(articleId)).kind, 'found', 'low-scoring eligible AI remains public');
  await upsertMaterial({ ...material, bodyText: '来源已更正的第二版验收材料。' });
  assert.equal((await sql`SELECT public_ready_at FROM publications WHERE article_id=${articleId}`)[0]!.public_ready_at, null);
  await analysis(2, 'block');
  await publishArticle(articleId);
  assert.equal((await loadItemDetail(articleId)).kind, 'not_found', 'a final blocked decision cannot bypass the public pool via detail');
  assert.equal(await loadItemShare(articleId), null);
  assert.equal((await itemAvailability([articleId]))[articleId], 'unavailable');
  await analysis(2);
  await publishArticle(articleId);
  assert.ok((await sql<{ public_ready_at: Date }[]>`SELECT public_ready_at FROM publications WHERE article_id=${articleId}`)[0]!.public_ready_at > ready);
});

test('development representatives retain within-AI score ordering through the SQL read', async () => {
  const storyId = randomUUID();
  const [story] = await sql`INSERT INTO stories(public_id,title,first_report_at,latest_at)
    VALUES(${storyId},'离线代表稿验收',now(),now()) RETURNING id`;
  stories.push(Number(story!.id));
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title)
    VALUES(${randomUUID()},${story!.id},'离线代表稿验收') RETURNING id`;
  const ids: string[] = [];
  for (const score of [60, 95]) {
    const { articleId } = await upsertMaterial({sourceId: source, url: `https://example.com/${source}/${score}`,
      title: '人工智能代表稿验收', bodyText: '用于检查同策略代表稿分数顺序的离线材料。', bodyStatus: 'ok', via: 'ingest'});
    ids.push(articleId);
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
      VALUES(${articleId},1,'rule','pass','ai','人工智能代表稿验收','离线摘要',${score},true)`;
    await sql`INSERT INTO fact_articles(fact_id,article_id,role)VALUES(${fact!.id},${articleId},'report')`;
    await publishArticle(articleId,{releasedAt: new Date(Date.now()-60_000)});
  }
  const result = await loadDevelopments({storyPublicId: storyId, channel: 'all', category: null, tag: null,
    topicTags: null, cursor: null, take: 20, revision: null});
  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') assert.equal(result.body.developments[0]?.representative.id, ids[1]);
  await sql`UPDATE publications SET visible_after=now()+interval '5 minutes' WHERE article_id=${ids[1]!}`;
  assert.equal((await loadItemDetail(ids[1]!)).kind, 'not_found', 'selected items wait for release on detail too');
  assert.equal(await loadItemShare(ids[1]!), null);
  assert.equal((await itemAvailability([ids[1]!]))[ids[1]!], 'unavailable');
});
