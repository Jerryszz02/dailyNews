// Offline pre/post fixture; import shared setup before business modules.
import { tag } from "../tests/setup.ts";
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { reconcileEditorialBatch } from "@aihot/backend/publication/batching";
import { stopBoss } from "@aihot/backend/jobs/queue";

const mode = process.env.EDITORIAL_BENCH_MODE ?? "before";
const snapshotPaths = [
  "../packages/backend/src/publication/editorial.benchmark-baseline.ts",
  "../packages/backend/src/publication/publish.benchmark-baseline.ts",
].map((p) => fileURLToPath(new URL(p, import.meta.url)));
if (mode === "before") {
  writeFileSync(snapshotPaths[0]!, execFileSync("git", ["show", "7234523:packages/backend/src/publication/editorial.ts"]));
  writeFileSync(snapshotPaths[1]!, execFileSync("git", ["show", "7234523:packages/backend/src/publication/publish.ts"], {
    encoding: "utf8",
  }).replace("\"./editorial.ts\"", "\"./editorial.benchmark-baseline.ts\""));
}
const { publishArticle } = mode === "before"
  ? await import("../packages/backend/src/publication/publish.benchmark-baseline.ts")
  : await import("@aihot/backend/publication/publish");
const t = tag(), sourceId = `batch-bench-${t}`;
const ids: string[] = [], facts: number[] = [], stories: number[] = [];
await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, config, next_fetch_at)
  VALUES (${sourceId}, '新华网', 'rss', 'T1', 'editorial', ${sql.json({ dailyNews: {
    legacySourceId: "xinhua", sectionId: sourceId, publisherKey: "xinhua",
    sourceCredibility: 88, mediaType: "wire", signalRole: "reporting",
  } })}, '2100-01-01')`;
try {
  for (let i = 0; i < 100; i++) {
    const title = `全国重大政策监管新规正式生效 ${i}`;
    const { articleId } = await upsertMaterial({ sourceId, url: `https://example.com/${t}/${i}`, title,
      bodyText: `${title}。有关机构披露适用范围、阶段安排、事实背景及后续影响。`,
      bodyStatus: "ok", via: "ingest", publishedAt: new Date(Date.now() - 3 * 3_600_000) });
    ids.push(articleId);
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh,
      summary_zh, reason_zh, score, selected, output)
      VALUES (${articleId}, 1, 'rule', 'pass', 'policy', ${title},
        ${title + "。有关机构披露适用范围、阶段安排、事实背景及后续影响。"}, 'fixture', 90, true,
        ${sql.json({ classification: { originalCategory: "policy", effectiveCategory: "policy" } })})`;
    const [s] = await sql`INSERT INTO stories (public_id, title, first_report_at, latest_at)
      VALUES (${randomUUID()}, ${title}, now(), now()) RETURNING id`;
    stories.push(s!.id);
    const [f] = await sql`INSERT INTO facts (public_id, story_id, title)
      VALUES (${randomUUID()}, ${s!.id}, ${title}) RETURNING id`;
    facts.push(f!.id);
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${f!.id}, ${articleId}, 'primary')`;
  }
  let queries = 0, reconciliations = 0;
  const old = sql.options.debug;
  sql.options.debug = (_id, query) => {
    queries++;
    if (query.includes("FROM facts f") && query.includes("LEFT JOIN fact_articles")) reconciliations++;
  };
  const start = performance.now(), cpu = process.cpuUsage();
  for (const id of ids) await publishArticle(id, mode === "after" ? { batchEditorial: true } : {});
  if (mode === "after") await reconcileEditorialBatch();
  const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
  sql.options.debug = old;
  const selected = await sql`SELECT article_id FROM publications
    WHERE article_id=ANY(${ids}) AND selected ORDER BY article_id`;
  console.log(JSON.stringify({ kind: mode + "100", publications: ids.length, queries, reconciliations,
    elapsedMs, cpuMs: (used.user + used.system) / 1000, selected: selected.length }));
} finally {
  await sql`DELETE FROM facts WHERE id=ANY(${facts}::bigint[])`;
  await sql`DELETE FROM stories WHERE id=ANY(${stories}::bigint[])`;
  await sql`DELETE FROM selected_ledger WHERE article_id=ANY(${ids}::text[])`;
  await sql`DELETE FROM selected_state WHERE article_id=ANY(${ids}::text[])`;
  await sql`DELETE FROM articles WHERE id=ANY(${ids}::text[])`;
  await sql`DELETE FROM sources WHERE id=${sourceId}`;
  await stopBoss();
  await closeDb();
  if (mode === "before") for (const p of snapshotPaths) unlinkSync(p);
}
