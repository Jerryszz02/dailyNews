import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { composeDaily, dailyCandidates, selectDailyCandidates, type Candidate } from "@aihot/backend/reports/compose";
import { CATEGORIES } from "@aihot/industry/taxonomy";

const T = tag();
const SOURCE = `daily-report-${T}`;
const ISSUE_DATE = `${2030 + Number.parseInt(T.slice(-5), 36) % 5000}-02-02`;
const END = new Date(`${ISSUE_DATE}T00:00:00Z`); // 08:00 Shanghai
const START = new Date(END.getTime() - 86400000);
const NEXT = new Date(END.getTime() + 86400000);
const at = (hoursFromEnd: number) => new Date(END.getTime() + hoursFromEnd * 3600000).toISOString();
const requests: string[] = [];
const provider = await stub((_hit, request) => {
  requests.push(request.body);
  return {
    id: `daily-report-${T}`,
    choices: [{ message: { content: JSON.stringify({ title: "日报测试标题", leadParagraph: "日报测试导语", highlights: [1] }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, '日报测试来源', 'rss', 'T1', 'editorial', '2100-01-01')`;
});

after(async () => {
  try {
    await sql.begin(async (tx) => {
      const articleIds = (await tx<{ id: string }[]>`SELECT id FROM articles WHERE source_id=${SOURCE}`).map((row) => row.id);
      const factIds = (await tx<{ id: number }[]>`
        SELECT id FROM facts WHERE starts_with(public_id, ${`daily-fact-${T}-`})`).map((row) => row.id);
      await tx`DELETE FROM reports WHERE kind='daily' AND key=${ISSUE_DATE}
        AND content->'lead'->>'title' = '日报测试标题'`;
      await tx`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${articleIds}::text[])`;
      await tx`DELETE FROM selected_ledger WHERE article_id=ANY(${articleIds}::text[])`;
      await tx`DELETE FROM selected_state WHERE article_id=ANY(${articleIds}::text[])`;
      await tx`DELETE FROM facts WHERE id=ANY(${factIds}::bigint[])`;
      await tx`DELETE FROM editorial_decisions WHERE (scope='fact' AND subject_id=ANY(${factIds.map(String)}::text[]))
        OR (scope='article' AND subject_id=ANY(${articleIds}::text[]))`;
      await tx`DELETE FROM articles WHERE id=ANY(${articleIds}::text[])`;
      await tx`DELETE FROM sources WHERE id=${SOURCE}`;
    });
  } finally {
    await provider.close();
    await stopBoss();
    await closeDb();
  }
});

function sample(category: string, index: number, score: number): Candidate {
  const at = new Date(END.getTime() - (100 - index) * 60_000).toISOString();
  return {
    itemId: `${category}-${index}`, factId: `${category}-${index}`, storyPublicId: null,
    title: `标题 ${index}`, summary: `摘要 ${index}`, sourceName: "来源", sourceUrl: "https://example.com",
    sourceId: SOURCE, firstParty: false, role: "媒体", score, publishedAt: at,
    category, factKey: `${category}-${index}`, eventAt: at,
  };
}

test("24 slots cover ten categories first, rotate remaining slots, then display by time", () => {
  const input = CATEGORIES.flatMap(({ key }, categoryIndex) => Array.from({ length: 5 }, (_, i) =>
    sample(key, categoryIndex * 10 + i, key === "ai" ? 99 : 10 - i)));
  const picked = selectDailyCandidates(input);
  assert.equal(picked.length, 24);
  assert.equal(new Set(picked.map((candidate) => candidate.factKey)).size, 24);
  assert.deepEqual(new Set(picked.map((candidate) => candidate.category)), new Set(CATEGORIES.map((category) => category.key)));
  // 24 = two full rounds of ten plus the first four categories in taxonomy order.
  assert.equal(picked.filter((candidate) => candidate.category === "ai").length, 3);
  assert.equal(picked.filter((candidate) => candidate.category === "policy").length, 2);
  assert.ok(picked.every((candidate, i) => i === 0 || picked[i - 1]!.eventAt >= candidate.eventAt));
  assert.notEqual(picked[0]!.category, "ai", "a high AI score never jumps ahead of later events from another policy");
});

async function article(label: string, category: string, timeline: string, ready: string, selected: boolean) {
  const { articleId, backfill } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/daily-report-${T}/${label}`,
    title: `${label}${T}原始标题`, bodyText: `${label}正文`.repeat(50), bodyStatus: "ok",
    publishedAt: new Date(timeline), discoveredAt: new Date(timeline), via: "fetch",
  });
  assert.equal(backfill, false);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
    VALUES (${articleId}, 1, 'rule', 'pass', ${category}, ${`${label}${T}中文标题`}, ${`${label}${T}中文摘要`}, 90, ${selected})`;
  return { articleId, ready: new Date(ready) };
}

async function fact(label: string, category: string, timeline: string, ready: string,
  evaluated: string, tier: "important" | "noise", selected = false) {
  const own = await article(label, category, timeline, ready, selected);
  const [f] = await sql<{ id: number; public_id: string }[]>`
    INSERT INTO facts (public_id, title) VALUES (${`daily-fact-${T}-${label}`}, ${label}) RETURNING id, public_id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${f!.id}, ${own.articleId}, 'primary')`;
  await publishArticle(own.articleId, { now: own.ready, skipEditorialReconcile: true });
  const [d] = await sql<{ id: number }[]>`
    INSERT INTO editorial_decisions (scope, subject_id, policy_id, policy_version, classification_version,
      input_signature, evidence_version, primary_category, score_kind, score, importance_tier, fact_status,
      selected, representative_article_id, evaluated_at)
    VALUES ('fact', ${String(f!.id)}, 'dailynews-non-ai-fact', 'test', 'test', ${`${T}-${label}`}, ${`${T}-${label}`},
      ${category}, 'legacy_curation_total', 70, ${tier}, 'confirmed', ${selected}, ${own.articleId}, ${new Date(evaluated)})
    RETURNING id`;
  await sql`INSERT INTO fact_editorial_state (fact_id, decision_id, primary_category, evidence_version, representative_article_id)
    VALUES (${f!.id}, ${d!.id}, ${category}, ${`${T}-${label}`}, ${own.articleId})`;
  return { ...own, factId: f!.id, decisionId: d!.id };
}

test("daily admits selected AI and unselected non-noise representatives, not noise or later decisions", async () => {
  const ai = await article("AI入选", "ai", at(-3), at(-2.8), true);
  await publishArticle(ai.articleId, { now: ai.ready, releasedAt: ai.ready, skipEditorialReconcile: true });
  const nonAi = await fact("非AI未精选", "finance", at(-2), at(-1.8), at(-1.6), "important");
  const secondary = await article("非AI第二报道", "finance", at(-1.5), at(-1.4), false);
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${nonAi.factId}, ${secondary.articleId}, 'report')`;
  await publishArticle(secondary.articleId, { now: secondary.ready, skipEditorialReconcile: true });
  const noise = await fact("噪声事实", "sports", at(-2), at(-1.8), at(-1.6), "noise");
  const late = await fact("过截止才决策", "policy", at(-0.5), at(-0.3), at(0.1), "important");
  const latePublicAi = await article("过截止才公开AI", "ai", at(-0.5), at(0.1), true);
  await publishArticle(latePublicAi.articleId, { now: latePublicAi.ready, releasedAt: latePublicAi.ready, skipEditorialReconcile: true });
  const rows = await dailyCandidates(START, END);
  assert.equal(rows.some((candidate) => candidate.itemId === ai.articleId), true);
  assert.equal(rows.some((candidate) => candidate.itemId === nonAi.articleId), true);
  assert.equal(rows.some((candidate) => candidate.itemId === secondary.articleId), false);
  assert.equal(rows.some((candidate) => candidate.itemId === noise.articleId), false);
  assert.equal(rows.some((candidate) => candidate.itemId === late.articleId), false);
  assert.equal(rows.some((candidate) => candidate.itemId === latePublicAi.articleId), false);
  assert.equal((await dailyCandidates(END, NEXT)).some((candidate) => candidate.itemId === late.articleId), true,
    "first qualifying fact decision moves the event to the next issue");
  assert.equal((await dailyCandidates(END, NEXT)).some((candidate) => candidate.itemId === latePublicAi.articleId), true,
    "the first public eligibility time keeps a post-cutoff AI item out of yesterday's issue");
  const [projection] = await sql<{ selected: boolean; public_ready_at: Date }[]>`
    SELECT selected, public_ready_at FROM publications WHERE article_id = ${nonAi.articleId}`;
  assert.equal(projection!.selected, false);
  assert.equal(projection!.public_ready_at.toISOString(), nonAi.ready.toISOString());

  const first = await composeDaily(ISSUE_DATE);
  assert.equal(first.entries, 2);
  assert.match(requests.at(-1) ?? "", /\[财经\]/);
  assert.match(requests.at(-1) ?? "", /\[人工智能\]/);
  const [saved] = await sql<{ revision: number; content: { storyOrder: string[]; sections: Array<{ label: string; items: Array<{ itemId: string }> }> } }[]>`
    SELECT revision, content FROM reports WHERE kind = 'daily' AND key = ${ISSUE_DATE}`;
  assert.equal(saved!.revision, 1);
  assert.deepEqual(new Set(saved!.content.sections.flatMap((section) => section.items.map((item) => item.itemId))),
    new Set([ai.articleId, nonAi.articleId]));
  assert.deepEqual(saved!.content.storyOrder, [nonAi.articleId, ai.articleId], "the reading order follows event time across sections");
  const calls = provider.hits();
  assert.deepEqual(await composeDaily(ISSUE_DATE), first, "scheduled rerun preserves the issued revision");
  assert.equal(provider.hits(), calls, "frozen edition does not purchase another lead");

  // A later ordinary time-based decision does not move an already qualified fact into the next issue.
  const [nextDecision] = await sql<{ id: number }[]>`
    INSERT INTO editorial_decisions (scope, subject_id, policy_id, policy_version, classification_version,
      input_signature, evidence_version, primary_category, score_kind, score, importance_tier, fact_status,
      selected, representative_article_id, evaluated_at)
    VALUES ('fact', ${String(nonAi.factId)}, 'dailynews-non-ai-fact', 'test', 'test', ${`${T}-reevaluated`}, ${`${T}-reevaluated`},
      'finance', 'legacy_curation_total', 65, 'important', 'confirmed', false, ${nonAi.articleId}, ${new Date(at(10))}) RETURNING id`;
  await sql`UPDATE fact_editorial_state SET decision_id = ${nextDecision!.id} WHERE fact_id = ${nonAi.factId}`;
  assert.equal((await dailyCandidates(END, NEXT)).some((candidate) => candidate.itemId === nonAi.articleId), false);
  assert.equal((await composeDaily(ISSUE_DATE, "correction")).entries, 1);
  const [corrected] = await sql<{ revision: number; content: { sections: Array<{ items: Array<{ itemId: string }> }> } }[]>`
    SELECT revision, content FROM reports WHERE kind='daily' AND key=${ISSUE_DATE}`;
  const [archive] = await sql<{ content: { sections: Array<{ items: Array<{ itemId: string }> }> } }[]>`
    SELECT content FROM report_revisions WHERE report_id=(SELECT id FROM reports WHERE kind='daily' AND key=${ISSUE_DATE}) AND revision=1`;
  assert.equal(corrected!.revision, 2);
  assert.equal(corrected!.content.sections.flatMap((section) => section.items).some((item) => item.itemId === nonAi.articleId), false);
  assert.equal(archive!.content.sections.flatMap((section) => section.items).some((item) => item.itemId === nonAi.articleId), true);
});
