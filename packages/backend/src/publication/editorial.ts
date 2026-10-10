// Global non-AI fact selection. One transaction owns the complete active selected set, so
// replacing a representative or losing a top/important slot changes the projection and ledger
// atomically. No model is called here; category changes enqueue bounded reanalysis.
import { readFileSync } from "node:fs";
import path from "node:path";
import { isCategoryKey } from "@aihot/contracts/taxonomy";
import { REPO_ROOT } from "../config.ts";
import { sql, type Tx } from "../db.ts";
import { chooseFactCategory, evaluateNonAiFacts, prepareNonAiFactFeatures, nextReevaluationAt, nonAiPolicyVersion, type NonAiEvidenceInput, type NonAiFactInput } from "../dailynews/non-ai.ts";
import type { LegacyStory } from "../dailynews/legacy/curation.ts";
import { CLASSIFICATION_CONFIG_VERSION, NON_AI_POLICY_VERSION, currentAnalysisSignature } from "../editorial/policy.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { applyFactSelectionTx, invalidatePolicyProjectionTx } from "./publish.ts";

const MAX_REANALYSIS_ENQUEUES = 100;
const FEATURE_POLICY_VERSION = `${nonAiPolicyVersion}:${CLASSIFICATION_CONFIG_VERSION}`;
interface FeatureCacheRow {
  fact_id: number;
  input_signature: string;
  policy_version: string;
  features: LegacyStory;
  evaluated_at: Date;
  next_reevaluation_at: Date | null;
}
type LegacySource = { source_id: string; credibility: number; mediaType: string; signalRole?: string; mayHavePaywall?: boolean };
const legacySources = new Map<string, LegacySource>((JSON.parse(readFileSync(path.join(REPO_ROOT, "reference/baselines/legacy-sources.json"), "utf8")) as { sources: LegacySource[] }).sources.map((s) => [s.source_id, s]));

interface FactMemberRow {
  fact_id: number;
  fact_title: string;
  fact_version: number;
  article_id: string | null;
  role: "primary" | "report" | "mention" | null;
  association_created_at: Date | null;
  article_revision: number | null;
  article_backfill: boolean | null;
  article_category: string | null;
  article_url: string | null;
  article_title: string | null;
  published_at: Date | null;
  source_updated_at: Date | null;
  discovered_at: Date | null;
  source_id: string | null;
  source_name: string | null;
  source_config: Record<string, unknown> | null;
  source_first_party: boolean | null;
  source_tier: string | null;
  publication_revision: number | null;
  publication_eligible: boolean | null;
  publication_selected: boolean | null;
  publication_visibility: string | null;
  publication_title: string | null;
  publication_summary: string | null;
  publication_policy: string | null;
  analysis_id: number | null;
  analysis_revision: number | null;
  analysis_origin: string | null;
  analysis_signature: string | null;
  analysis_category: string | null;
  analysis_output: Record<string, any> | null;
  override_category: string | null;
  override_updated_at: Date | null;
}
interface ExistingState { fact_id: number; decision_id: number | null; evidence_version: string; primary_category: string | null; representative_article_id: string | null; input_signature: string | null }

function modelCategory(row: FactMemberRow): string | null {
  if (row.analysis_origin !== "model") return row.analysis_category;
  const fallback = row.analysis_output?.classification?.fallback?.category;
  if (isCategoryKey(fallback)) return fallback;
  const original = row.analysis_output?.classification?.originalCategory;
  return isCategoryKey(original) ? original : null;
}

function sourceFacts(row: FactMemberRow): Pick<NonAiEvidenceInput, "legacySourceId" | "sourceCredibility" | "mediaType" | "signalRole" | "mayHavePaywall"> {
  const dailyNews = row.source_config?.dailyNews;
  const custom = dailyNews && typeof dailyNews === "object" ? dailyNews as Record<string, unknown> : {};
  const legacySourceId = typeof custom.legacySourceId === "string" ? custom.legacySourceId : row.source_id ?? "unknown";
  const old = legacySources.get(legacySourceId);
  const mediaType = typeof custom.mediaType === "string" ? custom.mediaType : old?.mediaType ?? "other";
  const signalRole = typeof custom.signalRole === "string" ? custom.signalRole : old?.signalRole ?? (row.source_first_party ? "first_party" : undefined);
  return {
    legacySourceId,
    sourceCredibility: typeof custom.sourceCredibility === "number" && Number.isFinite(custom.sourceCredibility) ? custom.sourceCredibility : old?.credibility ?? 45,
    mediaType: mediaType === "official" || mediaType === "wire" || mediaType === "social" ? mediaType : "other",
    signalRole: signalRole === "first_party" || signalRole === "reporting" || signalRole === "analysis" || signalRole === "discussion" ? signalRole : undefined,
    mayHavePaywall: typeof custom.mayHavePaywall === "boolean" ? custom.mayHavePaywall : old?.mayHavePaywall ?? false,
  };
}

/** Recalculate all facts in one short transaction under the publication lock. */
export async function reconcileEditorialPolicies(now: Date = new Date()): Promise<{ facts: number; selected: number; requeued: number }> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('dailynews-editorial-projection'))`;
    await tx`SELECT pg_advisory_xact_lock_shared(hashtext('report_candidates'))`;
    return reconcileEditorialPoliciesTx(tx, now);
  });
}

/** Caller has acquired dailynews-editorial-projection before any article row lock. */
export async function reconcileEditorialPoliciesTx(tx: Tx, now: Date): Promise<{ facts: number; selected: number; requeued: number }> {
  const rows = await tx<FactMemberRow[]>`
    SELECT f.id AS fact_id, f.title AS fact_title, f.version AS fact_version, fa.article_id, fa.role,
      fa.created_at AS association_created_at,
      a.revision AS article_revision, a.backfill AS article_backfill, a.editorial_category AS article_category, a.url AS article_url,
      a.title AS article_title, a.published_at, a.source_updated_at, a.discovered_at,
      s.id AS source_id, s.name AS source_name, s.config AS source_config, s.first_party AS source_first_party, s.tier AS source_tier,
      p.revision AS publication_revision, p.eligible AS publication_eligible, p.selected AS publication_selected, p.visibility AS publication_visibility,
      p.title AS publication_title, p.summary AS publication_summary, p.policy_id AS publication_policy,
      an.id AS analysis_id, an.input_revision AS analysis_revision, an.origin AS analysis_origin,
      an.input_signature AS analysis_signature, an.category AS analysis_category, an.output AS analysis_output,
      o.fields->>'category' AS override_category, o.updated_at AS override_updated_at
    FROM facts f
    LEFT JOIN fact_articles fa ON fa.fact_id = f.id
    LEFT JOIN articles a ON a.id = fa.article_id
    LEFT JOIN sources s ON s.id = a.source_id
    LEFT JOIN publications p ON p.article_id = a.id
    LEFT JOIN LATERAL (SELECT * FROM analyses WHERE article_id = a.id ORDER BY input_revision DESC, id DESC LIMIT 1) an ON true
    LEFT JOIN editorial_overrides o ON o.article_id = a.id
    ORDER BY f.id, (fa.role = 'primary') DESC, fa.created_at, fa.article_id`;
  const byFact = new Map<number, FactMemberRow[]>();
  for (const row of rows) byFact.set(row.fact_id, [...(byFact.get(row.fact_id) ?? []), row]);
  const existing = new Map((await tx<ExistingState[]>`
    SELECT fes.fact_id, fes.decision_id, fes.evidence_version, fes.primary_category, fes.representative_article_id,
      d.input_signature FROM fact_editorial_state fes LEFT JOIN editorial_decisions d ON d.id = fes.decision_id
  `).map((state) => [state.fact_id, state]));
  const signatureByArticle = new Map<string, string | null>();
  const candidates: NonAiFactInput[] = [];
  const categoryByFact = new Map<number, string | null>();
  const versionByFact = new Map<number, string>();
  const requeue: string[] = [];
  const invalidated = new Set<string>();

  for (const [factId, members] of byFact) {
    const valid = [] as FactMemberRow[];
    for (const row of members) {
      if (!row.article_id || !row.analysis_id || row.article_revision !== row.analysis_revision) continue;
      const historical = row.analysis_origin !== "model" && (process.env.DAILYNEWS_ALLOW_LEGACY_FIXTURES === "1" || !!row.article_backfill);
      if (row.analysis_origin === "model") {
        let current = signatureByArticle.get(row.article_id);
        if (current === undefined) {
          current = await currentAnalysisSignature(row.article_id, tx);
          signatureByArticle.set(row.article_id, current);
        }
        if (!current || row.analysis_signature !== current) continue;
      } else if (!historical) continue;
      valid.push(row);
    }
    const isReport = (row: FactMemberRow) => (row.role === "primary" || row.role === "report") && row.analysis_output?.scope !== "composite";
    const manual = members.filter((row) => isReport(row) && isCategoryKey(row.override_category)).sort((a, b) =>
      (b.override_updated_at?.getTime() ?? 0) - (a.override_updated_at?.getTime() ?? 0) || (a.article_id ?? "").localeCompare(b.article_id ?? ""))[0];
    const voteRows = valid.filter((row) => {
      if (!isReport(row)) return false;
      const category = modelCategory(row);
      return isCategoryKey(category) || isCategoryKey(row.override_category);
    });
    const category = manual?.override_category ?? (voteRows.length ? chooseFactCategory(voteRows.map((row) => ({
      title: row.publication_title ?? row.article_title ?? "", summary: row.publication_summary ?? "",
      primaryCategory: (isCategoryKey(modelCategory(row)) ? modelCategory(row) : row.override_category) as NonAiEvidenceInput["primaryCategory"],
      categories: [(isCategoryKey(modelCategory(row)) ? modelCategory(row) : row.override_category) as NonAiEvidenceInput["primaryCategory"]],
    }))) : null);
    categoryByFact.set(factId, category);
    if (!category) for (const row of members) {
      if (row.article_id && row.publication_selected && row.role !== "mention" && row.analysis_output?.scope !== "composite") {
        invalidated.add(row.article_id);
      }
    }
    const version = sha256(stableJson(members.map((row) => [row.fact_version, row.article_id, row.role,
      row.association_created_at?.toISOString(), row.article_revision, row.article_category,
      row.analysis_id, row.analysis_signature, row.analysis_output?.scope, row.override_category,
      row.override_updated_at?.toISOString(), row.publication_visibility, row.publication_eligible,
      row.source_tier, row.source_config, row.source_updated_at?.toISOString()])));
    versionByFact.set(factId, version);

    // A canonical category change invalidates member analyses. The queue only gets a bounded
    // number in this pass; the worker sweeper will pick up any remainder next time.
    if (category) for (const row of members) {
      if (row.role === "mention" || row.analysis_output?.scope === "composite") continue;
      const effective = isCategoryKey(row.analysis_output?.classification?.effectiveCategory)
        ? row.analysis_output!.classification.effectiveCategory : row.analysis_category;
      if (!row.article_id || row.article_category === category || (row.article_category === null && valid.includes(row) && effective === category)) continue;
      invalidated.add(row.article_id);
      if (requeue.length < MAX_REANALYSIS_ENQUEUES) {
        await tx`UPDATE articles SET editorial_category = ${category} WHERE id = ${row.article_id} AND editorial_category IS DISTINCT FROM ${category}`;
        requeue.push(row.article_id);
      }
    }
    if (!category || category === "ai") continue;
    const evidence: NonAiEvidenceInput[] = valid.filter((row) =>
      row.article_id && !invalidated.has(row.article_id) && row.role !== "mention" && row.publication_eligible && row.publication_visibility === "public" &&
      (row.article_category === category || (row.article_category === null &&
        (row.analysis_output?.classification?.effectiveCategory ?? row.analysis_category) === category)) &&
      row.publication_policy === "dailynews-non-ai-fact" &&
      row.analysis_output?.scope !== "composite"
    ).map((row) => ({
      articleId: row.article_id!, url: row.article_url!, title: row.publication_title ?? row.article_title ?? "",
      summary: row.publication_summary ?? "", primaryCategory: category as NonAiEvidenceInput["primaryCategory"],
      publishedAt: row.published_at?.toISOString(), updatedAt: row.source_updated_at?.toISOString(), discoveredAt: row.discovered_at?.toISOString(),
      sourceName: row.source_name ?? undefined, ...sourceFacts(row), association: row.role === "primary" || row.role === "report" ? "primary" : "mention",
      eligibleForPublication: true,
    }));
    if (evidence.length) candidates.push({ factId: String(factId), primaryCategory: category as NonAiFactInput["primaryCategory"], evidence });
  }
  // Keep the complete candidate set for global quotas/diversity. Expensive deterministic
  // evidence/text features are reused only for identical inputs before their time boundary.
  const cache = new Map((await tx<FeatureCacheRow[]>`
    SELECT fact_id, input_signature, policy_version, features, evaluated_at, next_reevaluation_at FROM fact_feature_cache
  `).map((row) => [String(row.fact_id), row]));
  const prepared = new Map<string, LegacyStory>();
  const changedFeatures: FeatureCacheRow[] = [];
  for (const input of candidates) {
    const signature = sha256(stableJson({ input, policy: FEATURE_POLICY_VERSION }));
    const prior = cache.get(input.factId);
    if (prior?.input_signature === signature && prior.policy_version === FEATURE_POLICY_VERSION && prior.evaluated_at <= now &&
      (!prior.next_reevaluation_at || prior.next_reevaluation_at > now)) {
      prepared.set(input.factId, prior.features);
    } else {
      const features = prepareNonAiFactFeatures(input, now);
      prepared.set(input.factId, features);
      const due = nextReevaluationAt(input, now);
      changedFeatures.push({ fact_id: Number(input.factId), input_signature: signature, policy_version: FEATURE_POLICY_VERSION,
        features, evaluated_at: now, next_reevaluation_at: due ? new Date(due) : null });
    }
  }
  if (changedFeatures.length) {
    await tx`INSERT INTO fact_feature_cache (fact_id, input_signature, policy_version, features, evaluated_at, next_reevaluation_at)
      SELECT fact_id, input_signature, policy_version, features, evaluated_at, next_reevaluation_at FROM jsonb_to_recordset(${tx.json(changedFeatures as never)})
        AS x(fact_id bigint, input_signature text, policy_version text, features jsonb, evaluated_at timestamptz, next_reevaluation_at timestamptz)
      ON CONFLICT (fact_id) DO UPDATE SET input_signature=excluded.input_signature, policy_version=excluded.policy_version,
        features=excluded.features, evaluated_at=excluded.evaluated_at, next_reevaluation_at=excluded.next_reevaluation_at`;
  }
  // Facts that lost all eligible evidence or moved to AI no longer own non-AI features.
  // Removing their cache also prevents obsolete source/policy versions waking every minute.
  const obsoleteFeatures = [...cache.keys()].filter((id) => !prepared.has(id)).map(Number);
  if (obsoleteFeatures.length) await tx`DELETE FROM fact_feature_cache WHERE fact_id=ANY(${obsoleteFeatures}::bigint[])`;
  const result = evaluateNonAiFacts(candidates, now, prepared);
  const decisions = new Map(result.facts.map((decision) => [Number(decision.factId), decision]));
  const selectedByArticle = new Map<string, { factId: number; decisionId: number; score: number; reason: string; category: string; tier: string; status: string; signature: string }>();
  const touchedNonAi = new Set<string>();
  for (const [factId, members] of byFact) {
    const decision = decisions.get(factId);
    const category = categoryByFact.get(factId) ?? null;
    const version = versionByFact.get(factId)!;
    const inputSignature = sha256(stableJson({ version, category, decision: decision ? {
      importance: decision.importance, tier: decision.tier, status: decision.status, collection: decision.collection,
      representativeArticleId: decision.representativeArticleId, nextReevaluationAt: decision.nextReevaluationAt,
    } : null }));
    const prior = existing.get(factId);
    let decisionId = prior?.decision_id ?? null;
    if (prior?.input_signature !== inputSignature) {
      const [inserted] = await tx<{ id: number }[]>`
        INSERT INTO editorial_decisions (scope, subject_id, policy_id, policy_version, classification_version,
          input_signature, evidence_version, primary_category, score_kind, score, importance_tier, fact_status,
          selected, representative_article_id, details, evaluated_at, next_reevaluation_at)
        VALUES ('fact', ${String(factId)}, ${category === "ai" ? "aihot-ai-article" : category ? "dailynews-non-ai-fact" : "classification-pending"},
          ${category === "ai" ? "aihot-3343fe2b20db-v1" : NON_AI_POLICY_VERSION}, ${CLASSIFICATION_CONFIG_VERSION},
          ${inputSignature}, ${version}, ${category}, ${decision ? "legacy_curation_total" : null},
          ${decision?.score ?? null}, ${decision?.tier ?? null}, ${decision?.status ?? null}, ${decision?.selected ?? false},
          ${decision?.representativeArticleId ?? null}, ${tx.json((decision ?? {}) as never)}, ${now},
          ${decision?.nextReevaluationAt ? new Date(decision.nextReevaluationAt) : null}) RETURNING id`;
      decisionId = inserted!.id;
    }
    await tx`INSERT INTO fact_editorial_state (fact_id, decision_id, primary_category, evidence_version, representative_article_id, next_reevaluation_at)
      VALUES (${factId}, ${decisionId}, ${category}, ${version}, ${decision?.representativeArticleId ?? null},
        ${decision?.nextReevaluationAt ? new Date(decision.nextReevaluationAt) : null})
      ON CONFLICT (fact_id) DO UPDATE SET decision_id=EXCLUDED.decision_id, primary_category=EXCLUDED.primary_category,
        evidence_version=EXCLUDED.evidence_version, representative_article_id=EXCLUDED.representative_article_id,
        next_reevaluation_at=EXCLUDED.next_reevaluation_at, updated_at=now()
      WHERE (fact_editorial_state.decision_id, fact_editorial_state.primary_category, fact_editorial_state.evidence_version,
        fact_editorial_state.representative_article_id, fact_editorial_state.next_reevaluation_at)
        IS DISTINCT FROM (EXCLUDED.decision_id, EXCLUDED.primary_category, EXCLUDED.evidence_version,
          EXCLUDED.representative_article_id, EXCLUDED.next_reevaluation_at)`;
    if (decision?.selected && decision.representativeArticleId && decisionId) selectedByArticle.set(decision.representativeArticleId, {
      factId, decisionId, score: decision.score, reason: `${decision.collection === "top" ? "今日必知" : "重要进展"}：公共影响 ${decision.importance.publicImpact}/100`,
      category: category!, tier: decision.tier, status: decision.status, signature: inputSignature,
    });
    // Include every former/current non-AI projection, so a fact-category flip or representative
    // withdrawal removes stale selected rows in the same transaction.
    for (const row of members) if (row.article_id && row.publication_policy === "dailynews-non-ai-fact") touchedNonAi.add(row.article_id);
  }
  for (const articleId of invalidated) await invalidatePolicyProjectionTx(tx, articleId, now);
  for (const articleId of touchedNonAi) if (!invalidated.has(articleId) && !selectedByArticle.has(articleId)) await applyFactSelectionTx(tx, articleId, null, now);
  for (const [articleId, selection] of selectedByArticle) await applyFactSelectionTx(tx, articleId, selection, now);
  for (const articleId of requeue) {
    const signature = await currentAnalysisSignature(articleId, tx);
    if (!signature) continue;
    const attemptTag = `policy:${signature}`;
    const [queued] = await tx<{ id: string }[]>`
      UPDATE articles SET processing_state='new', processing_attempts=0,
        processing_error='fact category changed', processing_retry_at=NULL,
        processing_queued_at=${now}, processing_attempt_tag=${attemptTag}
      WHERE id=${articleId} AND processing_attempt_tag IS DISTINCT FROM ${attemptTag} RETURNING id`;
    if (queued) await enqueue(QUEUES.analyze, { articleId, attemptTag },
      { singletonKey: `${articleId}:${attemptTag}`, priority: 0 }, tx);
  }
  return { facts: byFact.size, selected: selectedByArticle.size, requeued: requeue.length };
}

/** Time-only wake-up avoids a global pass when no fact is due. Admin/full rebuild remains explicit. */
export async function reconcileDueEditorialPolicies(now: Date = new Date()) {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('dailynews-editorial-projection'))`;
    await tx`SELECT pg_advisory_xact_lock_shared(hashtext('report_candidates'))`;
    const [due] = await tx<{ due: boolean }[]>`SELECT EXISTS(
      SELECT 1 FROM fact_editorial_state WHERE next_reevaluation_at <= ${now}
    ) OR EXISTS (
      SELECT 1 FROM fact_feature_cache WHERE policy_version <> ${FEATURE_POLICY_VERSION}
    ) AS due`;
    if (!due?.due) return { facts: 0, selected: 0, requeued: 0 };
    return reconcileEditorialPoliciesTx(tx, now);
  });
}
