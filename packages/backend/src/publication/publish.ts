// Publishing: derive the public projection of one article from its material, the latest judgement,
// manual overrides and grouping, then record selected-set changes in the sync ledger.
// Rebuilding only re-reads stored results; it never calls a model.
import { invalidateStoryInputs } from "../events/derived-content.ts";
import { SITE } from "@aihot/industry/site";
import { toPublicApiCategory } from "@aihot/contracts/taxonomy";
import { config } from "../config.ts";
import { one, sql, type Tx } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { itemUrl } from "./links.ts";
import { enqueue, QUEUES, shutdownSignal } from "../jobs/queue.ts";
import { isCategoryKey } from "@aihot/contracts/taxonomy";
import { CLASSIFICATION_CONFIG_VERSION, AI_POLICY_VERSION, NON_AI_POLICY_VERSION, currentAnalysisSignature } from "../editorial/policy.ts";
import { reconcileEditorialPoliciesTx } from "./editorial.ts";
import {
  bodyModeOf, channelOf, displayTags, isIndexable, isPoolEligible, isSelectable, mayRedistribute, type SourceFacts,
} from "./rules.ts";

interface ArticleRow {
  id: string;
  revision: number;
  editorial_category: string | null;
  source_id: string;
  url: string;
  title: string;
  language: string | null;
  published_at: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  backfill: boolean;
  body_status: string;
  body_text: string | null;
  x_post: unknown;
  grouped_at: Date | null;
}

interface AnalysisRow {
  id: number;
  input_revision: number;
  origin: string;
  input_signature: string | null;
  policy_id: string | null;
  policy_version: string | null;
  classification_version: string | null;
  relevance: string | null;
  category: string | null;
  tags: string[];
  subjects: string[];
  title_zh: string | null;
  summary_zh: string | null;
  reason_zh: string | null;
  score: number | null;
  selected: boolean | null;
}

interface OverrideRow {
  fields: Record<string, unknown>;
  visibility: string | null;
}

interface PublicationRow {
  article_id: string;
  revision: number;
  visibility: string;
  eligible: boolean;
  selected: boolean;
  title: string;
  original_title: string | null;
  summary: string | null;
  reason: string | null;
  category: string | null;
  tags: string[];
  score: number | null;
  body_mode: string;
  story_id: number | null;
  fact_id: number | null;
  selected_ready_at: Date | null;
  visible_after: Date | null;
  indexable: boolean;
  seo_indexed_at: Date | null;
  seo_excluded_at: Date | null;
  policy_id: string | null;
  decision_id: number | null;
  policy_signature: string | null;
  score_kind: string | null;
  importance_tier: string | null;
  fact_status: string | null;
}

export interface V1ItemPayload {
  id: string;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  source: { name: string };
  links: { aihot: string; original: string };
  publishedAt: string | null;
  discoveredAt: string;
  category: string | null;
  score: number | null;
  selected: boolean;
  reason: string | null;
  attribution: { name: string; url: string };
}

export interface PublishOptions {
  now?: Date;
  /** Historical import: the item was already public, so it is released at its discovery time. */
  releasedAt?: Date | null;
  /** Internal: a fact-wide reconcile is already in progress under the global lock. */
  skipEditorialReconcile?: boolean;
  /** Batch source/admin mutation: republish members, then reconcile once in the same transaction. */
  reconcileFacts?: boolean;
  /** A signature sweep owns its own enqueue, so it disables the publication fallback. */
  queueStaleAnalysis?: boolean;
}

export interface PublishResult {
  articleId: string;
  changed: boolean;
  selected: boolean;
  visibility: string;
  ledger: "upsert" | "remove" | null;
  /** Something that was public is now shown less (withdrawn, out of the pool or selection, full text revoked). */
  reduced: boolean;
}

function pickString(override: unknown, fallback: string | null): string | null {
  return typeof override === "string" && override.trim() !== "" ? override.trim() : fallback;
}

function round1(n: number | null): number | null {
  return n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10;
}

export function v1Payload(p: {
  articleId: string; title: string; originalTitle: string | null; summary: string | null; sourceName: string; url: string;
  publishedAt: Date | null; discoveredAt: Date; category: string | null; score: number | null; selected: boolean; reason: string | null;
}): V1ItemPayload {
  const aihot = itemUrl(p.articleId);
  return {
    id: p.articleId,
    title: p.title,
    originalTitle: p.originalTitle,
    summary: p.summary,
    source: { name: p.sourceName },
    links: { aihot, original: p.url },
    publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
    discoveredAt: p.discoveredAt.toISOString(),
    category: toPublicApiCategory(p.category),
    score: p.score === null ? null : Math.round(p.score),
    selected: p.selected,
    reason: p.selected ? p.reason : null,
    attribution: { name: SITE.name, url: aihot },
  };
}

/** Allocates the next ledger sequence under a transaction lock so sequence order equals commit order. */
async function appendLedger(tx: Tx, articleId: string, op: "upsert" | "remove", payload: V1ItemPayload | null, visibleAt: Date, now: Date): Promise<number> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('selected_ledger'))`;
  const { next } = one(await tx<{ next: number }[]>`SELECT coalesce(max(seq), 0) + 1 AS next FROM selected_ledger`);
  await tx`INSERT INTO selected_ledger (seq, article_id, op, changed_at, visible_at, payload)
           VALUES (${next}, ${articleId}, ${op}, ${now}, ${visibleAt}, ${payload ? tx.json(payload as never) : null})`;
  return next;
}

export async function publishArticle(articleId: string, options: PublishOptions = {}): Promise<PublishResult | null> {
  return sql.begin((tx) => publishArticleTx(tx, articleId, options));
}

export async function publishArticleTx(tx: Tx, articleId: string, options: PublishOptions = {}): Promise<PublishResult | null> {
  // Every publication or fact-wide recompute takes this before article row locks. Admin mutations
  // that already own the transaction use the same order.
  await tx`SELECT pg_advisory_xact_lock(hashtext('dailynews-editorial-projection'))`;
  const [article] = await tx<ArticleRow[]>`
    SELECT id, revision, editorial_category, source_id, url, title, language, published_at, discovered_at, timeline_at, backfill, body_status,
           body_text, x_post, grouped_at
    FROM articles WHERE id = ${articleId} FOR UPDATE`;
  if (!article) return null;
  // Reports take this lock exclusively while reading candidates. Hold it through commit so a
  // release stamped before their cutoff cannot commit after their candidate snapshot.
  await tx`SELECT pg_advisory_xact_lock_shared(hashtext('report_candidates'))`;
  const now = options.now ?? new Date(); // sample after both locks, which may span a report cutoff
  const [source] = await tx<SourceFacts[]>`
    SELECT id, name, kind, tier, participation_mode, first_party, site_fulltext, syndicate_fulltext FROM sources WHERE id = ${article.source_id}`;
  if (!source) return null;
  const [analysis] = await tx<AnalysisRow[]>`
    SELECT id, input_revision, origin, input_signature, policy_id, policy_version, classification_version,
           relevance, category, tags, subjects, title_zh, summary_zh, reason_zh, score, selected
    FROM analyses WHERE article_id = ${articleId} ORDER BY input_revision DESC, id DESC LIMIT 1`;
  const [override] = await tx<OverrideRow[]>`SELECT fields, visibility FROM editorial_overrides WHERE article_id = ${articleId}`;
  const [membership] = await tx<{ fact_id: number; story_id: number | null }[]>`
    SELECT fa.fact_id, f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
    LEFT JOIN stories s ON s.id = f.story_id
    WHERE fa.article_id = ${articleId} AND fa.role IN ('primary', 'report') AND (s.id IS NULL OR s.merged_into IS NULL)
    ORDER BY (fa.role = 'primary') DESC, fa.created_at LIMIT 1`;
  const [previous] = await tx<PublicationRow[]>`SELECT * FROM publications WHERE article_id = ${articleId}`;

  const f = override?.fields ?? {};
  const currentSignature = analysis?.origin === "model" ? await currentAnalysisSignature(articleId, tx) : null;
  const analysisValid = analysis && analysis.input_revision === article.revision && (
    analysis.origin === "model"
      ? !!analysis.input_signature && analysis.input_signature === currentSignature
      : article.backfill || process.env.DAILYNEWS_ALLOW_LEGACY_FIXTURES === "1"
  );
  const currentAnalysis = analysisValid ? analysis : null;
  if (analysis && !analysisValid && analysis.origin === "model" && options.queueStaleAnalysis !== false && currentSignature) {
    const attemptTag = `policy:${currentSignature}`;
    const [queued] = await tx<{ id: string }[]>`
      UPDATE articles SET processing_state='new', processing_attempts=0, processing_error='policy invalidated',
        processing_retry_at=NULL, processing_queued_at=${now}, processing_attempt_tag=${attemptTag}
      WHERE id=${articleId} AND processing_attempt_tag IS DISTINCT FROM ${attemptTag} RETURNING id`;
    if (queued) await enqueue(QUEUES.analyze, { articleId, attemptTag },
      { singletonKey: `${articleId}:${attemptTag}`, priority: 0 }, tx);
  }
  const isChineseTitle = article.language === "zh" || /[一-鿿]/.test(article.title);
  // An X post carries its Chinese in the summary and translation; without a Chinese title its own
  // text is the title, where an article would still be a half-finished card.
  const zhTitle = currentAnalysis?.title_zh?.trim() ? currentAnalysis.title_zh : null;
  const title = pickString(f.title, zhTitle ?? (isChineseTitle || article.x_post ? collapseWhitespace(article.title) : null));
  const summary = pickString(f.summary, currentAnalysis?.summary_zh ?? null);
  const rawCategory = pickString(f.category, article.editorial_category ?? currentAnalysis?.category ?? null);
  const category = isCategoryKey(rawCategory) && currentAnalysis ? rawCategory : null;
  const tags = Array.isArray(f.tags) ? (f.tags as string[]) : [...new Set([...(currentAnalysis?.tags ?? []), ...(currentAnalysis?.subjects ?? []).map((s) => `entity:${s}`)])];
  const score = typeof f.score === "number" ? f.score : currentAnalysis?.score ?? null;
  const relevance = typeof f.relevance === "string" ? (f.relevance as string) : currentAnalysis?.relevance ?? null;
  const judgedSelected = typeof f.selected === "boolean" ? (f.selected as boolean) : currentAnalysis?.selected ?? null;
  // Material from an isolated source reaches no public surface at all: not even a detail page.
  const visibility = source.participation_mode === "isolated" ? "withdrawn" : (override?.visibility ?? "public");

  const eligible = !!category && isPoolEligible({ participationMode: source.participation_mode, relevance, title, summary });
  const nonAi = category !== null && category !== "ai";
  const selected = nonAi
    ? !!(eligible && membership && visibility === "public" && previous?.policy_id === "dailynews-non-ai-fact" && previous.selected)
    : category === "ai" && isSelectable(eligible, judgedSelected, source.tier);
  const reason = selected && nonAi ? previous?.reason ?? null : selected ? pickString(f.reason, currentAnalysis?.reason_zh ?? null) : null;
  const hasXPost = !!article.x_post;
  const channel = channelOf(source.kind, hasXPost);
  const bodyMode = bodyModeOf(source, article.body_status, !!article.body_text && article.body_text.length > 0);
  const syndicate = mayRedistribute(source, bodyMode);
  const originalTitle = isChineseTitle && title === collapseWhitespace(article.title) ? null : collapseWhitespace(article.title);

  // Release gate: first time the item met the selected conditions, released after grouping or 180 s.
  let selectedReadyAt = previous?.selected_ready_at ?? null;
  let visibleAfter = previous?.visible_after ?? null;
  if (selected && !selectedReadyAt) {
    selectedReadyAt = options.releasedAt ?? now;
    visibleAfter = options.releasedAt
      ? options.releasedAt
      : article.grouped_at && article.grouped_at <= now
        ? now
        : new Date(now.getTime() + config.selectedVisibleAfterSeconds * 1000);
  } else if (selected && visibleAfter && visibleAfter > now && article.grouped_at && article.grouped_at <= now) {
    const earliest = new Date(Math.max(selectedReadyAt!.getTime(), article.grouped_at.getTime()));
    if (earliest < visibleAfter) {
      // A grouping decision can predate publication. Reports wait for this release to commit.
      visibleAfter = new Date(Math.max(earliest.getTime(), now.getTime()));
      // The not-yet-visible sync entry follows the same release time as the site.
      await tx`UPDATE selected_ledger SET visible_at = ${visibleAfter} WHERE article_id = ${articleId} AND visible_at > ${visibleAfter}`;
    }
  }

  const indexable = isIndexable({
    visibility, hasSummary: !!summary, selected, seoIndexedAt: previous?.seo_indexed_at ?? null, seoExcludedAt: previous?.seo_excluded_at ?? null,
  });
  const searchText = collapseWhitespace(
    [title, originalTitle, summary, source.name, ...displayTags(tags), ...(currentAnalysis?.subjects ?? [])].filter(Boolean).join(" "),
  ).toLowerCase();

  // A selected item sits at its reading group's anchor: the earliest public pool member of its fact.
  let sortAt: Date = article.timeline_at;
  if (selected && membership?.fact_id) {
    const [anchor] = await tx<{ t: Date | null }[]>`
      SELECT min(timeline_at) AS t FROM publications
      WHERE fact_id = ${membership.fact_id} AND eligible AND visibility = 'public' AND article_id <> ${articleId}`;
    if (anchor?.t && anchor.t < sortAt) sortAt = anchor.t;
  }

  const next = {
    visibility, eligible, selected, title: title ?? collapseWhitespace(article.title), original_title: originalTitle, summary, reason,
    category, tags, score: nonAi && selected ? previous?.score ?? null : nonAi ? null : round1(score), body_mode: bodyMode, story_id: membership?.story_id ?? null, fact_id: membership?.fact_id ?? null,
    indexable,
  };
  const baseChanged =
    !previous ||
    stableJson({ ...next, tags: [...next.tags].sort() }) !==
      stableJson({
        visibility: previous.visibility, eligible: previous.eligible, selected: previous.selected, title: previous.title,
        original_title: previous.original_title, summary: previous.summary, reason: previous.reason, category: previous.category,
        tags: [...previous.tags].sort(), score: previous.score === null ? null : Number(previous.score), body_mode: previous.body_mode,
        story_id: previous.story_id, fact_id: previous.fact_id, indexable: previous.indexable,
      });
  const revision = previous ? previous.revision + (baseChanged ? 1 : 0) : 1;

  await tx`
    INSERT INTO publications (article_id, analysis_id, revision, visibility, eligible, selected, title, original_title, summary,
      reason, category, tags, score, source_id, channel, first_party, url, published_at, discovered_at, timeline_at, backfill,
      selected_ready_at, visible_after, body_mode, syndicate, indexable, story_id, fact_id, search_text, sort_at, updated_at)
    VALUES (${articleId}, ${currentAnalysis?.id ?? null}, ${revision}, ${visibility}, ${eligible}, ${selected}, ${next.title},
      ${originalTitle}, ${summary}, ${reason}, ${category}, ${tags}, ${next.score}, ${source.id}, ${channel}, ${source.first_party},
      ${article.url}, ${article.published_at}, ${article.discovered_at}, ${article.timeline_at}, ${article.backfill},
      ${selectedReadyAt}, ${visibleAfter}, ${bodyMode}, ${syndicate}, ${indexable}, ${next.story_id}, ${next.fact_id}, ${searchText}, ${sortAt}, now())
    ON CONFLICT (article_id) DO UPDATE SET
      analysis_id = EXCLUDED.analysis_id, revision = EXCLUDED.revision, visibility = EXCLUDED.visibility,
      eligible = EXCLUDED.eligible, selected = EXCLUDED.selected, title = EXCLUDED.title, original_title = EXCLUDED.original_title,
      summary = EXCLUDED.summary, reason = EXCLUDED.reason, category = EXCLUDED.category, tags = EXCLUDED.tags,
      score = EXCLUDED.score, source_id = EXCLUDED.source_id, channel = EXCLUDED.channel, first_party = EXCLUDED.first_party,
      url = EXCLUDED.url, published_at = EXCLUDED.published_at, discovered_at = EXCLUDED.discovered_at,
      timeline_at = EXCLUDED.timeline_at, backfill = EXCLUDED.backfill, selected_ready_at = EXCLUDED.selected_ready_at,
      visible_after = EXCLUDED.visible_after, body_mode = EXCLUDED.body_mode, syndicate = EXCLUDED.syndicate,
      indexable = EXCLUDED.indexable, story_id = EXCLUDED.story_id, fact_id = EXCLUDED.fact_id,
      search_text = EXCLUDED.search_text, sort_at = EXCLUDED.sort_at, updated_at = now()
    WHERE (publications.analysis_id, publications.revision, publications.visibility, publications.eligible,
        publications.selected, publications.title, publications.original_title, publications.summary,
        publications.reason, publications.category, publications.tags, publications.score,
        publications.source_id, publications.channel, publications.first_party, publications.url,
        publications.published_at, publications.discovered_at, publications.timeline_at, publications.backfill,
        publications.selected_ready_at, publications.visible_after, publications.body_mode, publications.syndicate,
        publications.indexable, publications.story_id, publications.fact_id, publications.search_text,
        publications.sort_at)
      IS DISTINCT FROM (EXCLUDED.analysis_id, EXCLUDED.revision, EXCLUDED.visibility, EXCLUDED.eligible,
        EXCLUDED.selected, EXCLUDED.title, EXCLUDED.original_title, EXCLUDED.summary,
        EXCLUDED.reason, EXCLUDED.category, EXCLUDED.tags, EXCLUDED.score,
        EXCLUDED.source_id, EXCLUDED.channel, EXCLUDED.first_party, EXCLUDED.url,
        EXCLUDED.published_at, EXCLUDED.discovered_at, EXCLUDED.timeline_at, EXCLUDED.backfill,
        EXCLUDED.selected_ready_at, EXCLUDED.visible_after, EXCLUDED.body_mode, EXCLUDED.syndicate,
        EXCLUDED.indexable, EXCLUDED.story_id, EXCLUDED.fact_id, EXCLUDED.search_text,
        EXCLUDED.sort_at)`;

  const policyId = category === "ai" ? "aihot-ai-article" : nonAi ? "dailynews-non-ai-fact" : "classification-pending";
  const policyVersion = category === "ai" ? AI_POLICY_VERSION : nonAi ? NON_AI_POLICY_VERSION : CLASSIFICATION_CONFIG_VERSION;
  const metadata = await tx`
    UPDATE publications SET decision_id = ${nonAi && selected ? previous?.decision_id ?? null : null},
      policy_id = ${policyId}, policy_version = ${policyVersion},
      classification_version = ${currentAnalysis?.classification_version ?? CLASSIFICATION_CONFIG_VERSION},
      policy_signature = ${nonAi && selected ? previous?.policy_signature ?? null : currentAnalysis?.input_signature ?? null},
      input_revision = ${article.revision}, policy_tier = ${source.tier},
      score_kind = ${category === "ai" ? "ai_attention" : nonAi && selected ? previous?.score_kind ?? null : null},
      importance_tier = ${nonAi && selected ? previous?.importance_tier ?? null : null},
      fact_status = ${nonAi && selected ? previous?.fact_status ?? null : null},
      revision = revision + ${previous && !baseChanged ? 1 : 0}
    WHERE article_id = ${articleId} AND
      (decision_id, policy_id, policy_version, classification_version, policy_signature,
       input_revision, policy_tier, score_kind, importance_tier, fact_status)
      IS DISTINCT FROM (${nonAi && selected ? previous?.decision_id ?? null : null}, ${policyId}, ${policyVersion},
       ${currentAnalysis?.classification_version ?? CLASSIFICATION_CONFIG_VERSION},
       ${nonAi && selected ? previous?.policy_signature ?? null : currentAnalysis?.input_signature ?? null},
       ${article.revision}, ${source.tier},
       ${category === "ai" ? "ai_attention" : nonAi && selected ? previous?.score_kind ?? null : null},
       ${nonAi && selected ? previous?.importance_tier ?? null : null}, ${nonAi && selected ? previous?.fact_status ?? null : null})`;
  const changed = baseChanged || metadata.count > 0;

  // The pool search row follows eligibility; its body part only covers full text the site may show.
  if (eligible) {
    const body = bodyMode === "full" ? (article.body_text ?? "").slice(0, 12000).toLowerCase() : "";
    await tx`INSERT INTO pool_search (article_id, direct, body) VALUES (${articleId}, ${searchText}, ${body})
             ON CONFLICT (article_id) DO UPDATE SET direct = EXCLUDED.direct, body = EXCLUDED.body
             WHERE pool_search.direct IS DISTINCT FROM EXCLUDED.direct OR pool_search.body IS DISTINCT FROM EXCLUDED.body`;
  } else {
    await tx`DELETE FROM pool_search WHERE article_id = ${articleId}`;
  }

  // Content-group push: once, for an item that arrives live and becomes selected (never for imports,
  // backfill or stale-on-discovery material); it runs after the release gate opens.
  if (selected && !previous?.selected_ready_at && !options.releasedAt && !article.backfill && visibility === "public") {
    const at = visibleAfter && visibleAfter > now ? visibleAfter : now;
    await enqueue(QUEUES.notifySelected, { articleId }, { singletonKey: `selected:${articleId}`, startAfter: new Date(at.getTime() + 5_000) }, tx);
    // Its images are fetched and resized now, before the release gate lets readers in.
    await enqueue(QUEUES.prepareMedia, { articleId }, { singletonKey: `media:${articleId}` }, tx);
  }

  // Selected sync ledger: the public selected set is (selected AND visibility = public).
  const inSet = selected && visibility === "public";
  const [state] = await tx<{ in_set: boolean; payload_hash: string | null }[]>`SELECT in_set, payload_hash FROM selected_state WHERE article_id = ${articleId}`;
  let ledger: "upsert" | "remove" | null = null;
  if (inSet) {
    const payload = v1Payload({
      articleId, title: next.title, originalTitle, summary, sourceName: source.name, url: article.url,
      publishedAt: article.published_at, discoveredAt: article.discovered_at, category, score: next.score, selected: true, reason,
    });
    const payloadHash = sha256(stableJson(payload));
    if (!state || !state.in_set || state.payload_hash !== payloadHash) {
      const visibleAt = visibleAfter && visibleAfter > now ? visibleAfter : now;
      const seq = await appendLedger(tx, articleId, "upsert", payload, visibleAt, now);
      await tx`INSERT INTO selected_state (article_id, in_set, payload_hash, last_seq) VALUES (${articleId}, true, ${payloadHash}, ${seq})
               ON CONFLICT (article_id) DO UPDATE SET in_set = true, payload_hash = EXCLUDED.payload_hash, last_seq = EXCLUDED.last_seq`;
      ledger = "upsert";
    }
  } else if (state?.in_set) {
    const seq = await appendLedger(tx, articleId, "remove", null, now, now);
    await tx`UPDATE selected_state SET in_set = false, payload_hash = NULL, last_seq = ${seq} WHERE article_id = ${articleId}`;
    ledger = "remove";
  }

  const wasPublic = !!previous && previous.visibility !== "withdrawn" && previous.eligible;
  const reduced =
    wasPublic &&
    (visibility === "withdrawn" || !eligible ||
      (previous!.visibility === "public" && visibility !== "public") ||
      (previous!.selected && !selected) ||
      (previous!.body_mode === "full" && bodyMode !== "full"));
  // 全文许可和精选排序不是摘要撤回；只在事件输入的权限或文字变化时同步失效。
  if (previous && (previous.visibility === "public" || visibility === "public") &&
      (previous.visibility !== visibility || previous.eligible !== eligible || previous.title !== next.title || previous.summary !== summary)) {
    await invalidateStoryInputs(tx, [articleId], now);
  }
  if (!options.skipEditorialReconcile && options.reconcileFacts !== false) await reconcileEditorialPoliciesTx(tx, now);
  const [final] = await tx<{ selected: boolean; visibility: string }[]>`SELECT selected, visibility FROM publications WHERE article_id = ${articleId}`;
  return { articleId, changed, selected: final?.selected ?? selected, visibility: final?.visibility ?? visibility, ledger, reduced };
}

export interface FactSelection {
  factId: number;
  decisionId: number;
  score: number;
  reason: string;
  category: string;
  tier: string;
  status: string;
  signature: string;
}

/** Called only while the global publication lock is held. Updates the publication and sync set together. */
export async function applyFactSelectionTx(tx: Tx, articleId: string, selection: FactSelection | null, now: Date): Promise<"upsert" | "remove" | null> {
  const [p] = await tx<{
    article_id: string; visibility: string; eligible: boolean; selected: boolean; title: string; original_title: string | null;
    summary: string | null; source_name: string; url: string; published_at: Date | null; discovered_at: Date;
    selected_ready_at: Date | null; visible_after: Date | null; grouped_at: Date | null; score: number | null;
    reason: string | null; decision_id: number | null; policy_id: string | null; policy_signature: string | null; category: string | null;
    importance_tier: string | null; fact_status: string | null; seo_indexed_at: Date | null; seo_excluded_at: Date | null;
  }[]>`
    SELECT p.article_id, p.visibility, p.eligible, p.selected, p.title, p.original_title, p.summary,
      s.name AS source_name, p.url, p.published_at, p.discovered_at, p.selected_ready_at, p.visible_after,
      a.grouped_at, p.score, p.reason, p.decision_id, p.policy_id, p.policy_signature, p.category, p.importance_tier,
      p.fact_status, p.seo_indexed_at, p.seo_excluded_at
    FROM publications p JOIN sources s ON s.id = p.source_id JOIN articles a ON a.id = p.article_id
    WHERE p.article_id = ${articleId} FOR UPDATE OF p`;
  if (!p || p.visibility !== "public" || !p.eligible || (selection && p.category !== selection.category)) selection = null;
  if (!p || p.policy_id === "aihot-ai-article") return null;
  const selected = !!selection;
  const score = selection ? round1(selection.score) : null;
  const reason = selection?.reason ?? null;
  const readyAt = selection ? p.selected_ready_at ?? now : p.selected_ready_at;
  const visibleAfter = selection ? p.visible_after ?? (p.grouped_at && p.grouped_at <= now ? now : new Date(now.getTime() + config.selectedVisibleAfterSeconds * 1000)) : p.visible_after;
  const indexable = isIndexable({ visibility: p.visibility, hasSummary: !!p.summary, selected,
    seoIndexedAt: p.seo_indexed_at, seoExcludedAt: p.seo_excluded_at });
  await tx`
    UPDATE publications SET selected=${selected}, score=${score}, reason=${reason},
      decision_id=${selection?.decisionId ?? null}, policy_signature=${selection?.signature ?? null},
      score_kind=${selection ? "legacy_curation_total" : null}, importance_tier=${selection?.tier ?? null},
      fact_status=${selection?.status ?? null}, selected_ready_at=${readyAt}, visible_after=${visibleAfter},
      indexable=${indexable}, revision=revision+1, updated_at=now()
    WHERE article_id=${articleId} AND
      (selected, score, reason, decision_id, policy_signature, score_kind, importance_tier, fact_status, indexable)
      IS DISTINCT FROM (${selected}, ${score}, ${reason}, ${selection?.decisionId ?? null}, ${selection?.signature ?? null},
        ${selection ? "legacy_curation_total" : null}, ${selection?.tier ?? null}, ${selection?.status ?? null}, ${indexable})`;
  const [state] = await tx<{ in_set: boolean; payload_hash: string | null }[]>`
    SELECT in_set, payload_hash FROM selected_state WHERE article_id=${articleId}`;
  if (selected) {
    const payload = v1Payload({ articleId, title: p.title, originalTitle: p.original_title, summary: p.summary,
      sourceName: p.source_name, url: p.url, publishedAt: p.published_at, discoveredAt: p.discovered_at,
      category: selection!.category, score, selected: true, reason });
    const hash = sha256(stableJson(payload));
    if (!state || !state.in_set || state.payload_hash !== hash) {
      const seq = await appendLedger(tx, articleId, "upsert", payload, visibleAfter && visibleAfter > now ? visibleAfter : now, now);
      await tx`INSERT INTO selected_state (article_id, in_set, payload_hash, last_seq)
        VALUES (${articleId}, true, ${hash}, ${seq})
        ON CONFLICT (article_id) DO UPDATE SET in_set=true, payload_hash=EXCLUDED.payload_hash, last_seq=EXCLUDED.last_seq`;
      return "upsert";
    }
  } else if (state?.in_set) {
    const seq = await appendLedger(tx, articleId, "remove", null, now, now);
    await tx`UPDATE selected_state SET in_set=false, payload_hash=NULL, last_seq=${seq} WHERE article_id=${articleId}`;
    return "remove";
  }
  return null;
}

/** Invalidate a former policy result before its newly canonical fact category is re-analysed. */
export async function invalidatePolicyProjectionTx(tx: Tx, articleId: string, now: Date): Promise<void> {
  const [before] = await tx<{ visibility: string; eligible: boolean; selected: boolean }[]>`
    SELECT visibility, eligible, selected FROM publications WHERE article_id=${articleId} FOR UPDATE`;
  if (!before) return;
  await tx`UPDATE publications SET analysis_id=NULL, decision_id=NULL, eligible=false, selected=false,
    category=NULL, score=NULL, reason=NULL, policy_id='classification-pending',
    policy_signature=NULL, score_kind=NULL, importance_tier=NULL, fact_status=NULL,
    indexable=false, revision=revision+1, updated_at=now()
    WHERE article_id=${articleId} AND
      (eligible OR selected OR category IS NOT NULL OR decision_id IS NOT NULL OR analysis_id IS NOT NULL)`;
  await tx`DELETE FROM pool_search WHERE article_id=${articleId}`;
  const [state] = await tx<{ in_set: boolean }[]>`SELECT in_set FROM selected_state WHERE article_id=${articleId}`;
  if (state?.in_set) {
    const seq = await appendLedger(tx, articleId, "remove", null, now, now);
    await tx`UPDATE selected_state SET in_set=false, payload_hash=NULL, last_seq=${seq} WHERE article_id=${articleId}`;
  }
  if (before.visibility === "public" && before.eligible) await invalidateStoryInputs(tx, [articleId], now);
}

/** The search-index decision and resulting projection share the editor's transaction. */
export async function setSeoDecision(tx: Tx, articleId: string, indexed: boolean): Promise<PublishResult | null> {
  await tx`UPDATE publications SET seo_indexed_at = CASE WHEN ${indexed} THEN coalesce(seo_indexed_at, now()) ELSE NULL END,
              seo_excluded_at = CASE WHEN ${indexed} THEN NULL ELSE now() END WHERE article_id = ${articleId}`;
  return publishArticleTx(tx, articleId);
}

/**
 * Re-derives every published article of one source (after its participation, licences, tier or name
 * changed) without calling models. Runs in the worker; progress goes to the callback.
 */
export async function republishSource(sourceId: string, onProgress?: (done: number, total: number) => Promise<void>): Promise<{ total: number; changed: number; reduced: number }> {
  const { total } = one(await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM publications WHERE source_id = ${sourceId}`);
  let after = "";
  let done = 0;
  let changed = 0;
  let reduced = 0;
  for (;;) {
    const batch = await sql<{ article_id: string }[]>`
      SELECT article_id FROM publications WHERE source_id = ${sourceId} AND article_id > ${after} ORDER BY article_id LIMIT 500`;
    if (batch.length === 0) break;
    for (const { article_id } of batch) {
      // Stopping mid-way is safe: the job is retried after the restart and re-derives from the start.
      if (shutdownSignal.signal.aborted) throw new Error("worker is stopping; republish resumes after restart");
      const r = await publishArticle(article_id);
      if (r?.changed) changed += 1;
      if (r?.reduced) reduced += 1;
    }
    done += batch.length;
    after = batch[batch.length - 1]!.article_id;
    await onProgress?.(done, total);
  }
  return { total, changed, reduced };
}
