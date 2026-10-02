import { sql } from "@aihot/backend/db";

/** Give a directly inserted public projection the same current revision/source provenance as a published report. */
export async function attachCurrentPublicationDecision(articleId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const [analysis] = await tx<{ id: number; input_revision: number; tier: string }[]>`
      INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, selected, output)
      SELECT a.id, a.revision, 'rule', 'pass', 'policy', a.title, a.title, true,
        ${tx.json({ classification: { originalCategory: "policy", effectiveCategory: "policy" } })}
      FROM articles a WHERE a.id=${articleId}
      RETURNING id, input_revision, (SELECT tier FROM sources WHERE id=(SELECT source_id FROM articles WHERE id=${articleId})) AS tier`;
    if (!analysis) throw new Error(`Missing article fixture: ${articleId}`);
    const updated = await tx`
      UPDATE publications SET analysis_id=${analysis.id}, input_revision=${analysis.input_revision},
        policy_id='fixture-rule', policy_tier=${analysis.tier}
      WHERE article_id=${articleId}`;
    if (updated.count !== 1) throw new Error(`Missing publication fixture: ${articleId}`);
  });
}
