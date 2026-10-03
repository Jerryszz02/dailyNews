// Share images only need public title/summary metadata. Keep the same page visibility rule without
// loading bodies, translations, related stories or signed media that never appear on these cards.
import type { CategoryKey } from '@aihot/contracts/taxonomy';
import { sql } from '../db.ts';
import { hasItemPage } from './rules.ts';
import { currentDecisionCondition, releasedCondition } from './scope.ts';

export async function loadItemShare(id: string) {
  const [row] = await sql<{
    id: string; title: string; summary: string | null; category: CategoryKey | null; selected: boolean;
    score: number | null; score_kind: string | null; timeline_at: Date; source_name: string; source_mode: string; visibility: string;
  }[]>`SELECT p.article_id AS id, p.title, p.summary, p.category, p.selected, p.score, p.score_kind, p.timeline_at,
      s.name AS source_name, s.participation_mode AS source_mode, p.visibility
    FROM publications p JOIN sources s ON s.id = p.source_id
    WHERE p.article_id = ${id} AND ${currentDecisionCondition()} AND ${releasedCondition(new Date())}`;
  if (!row || !hasItemPage({ visibility: row.visibility, sourceMode: row.source_mode })) return null;
  return { id: row.id, title: row.title, summary: row.summary, category: row.category, selected: row.selected,
    score: row.score === null ? null : Math.round(Number(row.score)), scoreKind: row.score_kind, timelineAt: row.timeline_at.toISOString(),
    source: { name: row.source_name } };
}
