// Daily, weekly and monthly reports. Windows are Beijing calendar based and written into the report;
// missed schedule points are caught up; regeneration creates a revision. The editors' prompts are in
// the industry pack (industry/prompts/report-*.md), the sections follow its categories.
import { z } from "zod";
import { SITE } from "@aihot/industry/site";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { modelFor } from "../editorial/models.ts";
import { addDays, beijingDate, beijingMidnight, isoWeekLabel, isoWeekRange } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { Conflict } from "../audit.ts";
import { chatJson, ModelOutputError } from "../providers/llm.ts";
import { completeReceipt, rejectReceivedResponse } from "../providers/receipts.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { currentDecisionCondition } from "../publication/scope.ts";

export const REPORT_VERSION = promptVersion("report-daily-lead", "report-period");

const SECTION_OF: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.section]));
const SECTION_ORDER = [...new Set(CATEGORIES.map((c) => c.section))];
/** Where an item without a category goes. */
const DEFAULT_SECTION = SECTION_OF.industry ?? SECTION_ORDER.at(-1)!;

export interface ReportEntry {
  itemId: string;
  factId: string | null;
  storyPublicId: string | null;
  title: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  sourceId: string;
  firstParty: boolean;
  role: string;
  score: number | null;
  publishedAt: string;
}

export interface Candidate extends ReportEntry {
  category: string | null;
  factKey: string;
  /** Later of the source timeline and the gates that first made this item a report candidate. */
  eventAt: string;
}

function roleOf(kind: string, firstParty: boolean): string {
  if (firstParty) return kind === "x_search" ? "X·官方" : "官方";
  if (kind === "x_search") return "X·KOL";
  if (kind === "mp_account") return "公众号";
  return "媒体";
}

async function reportCandidates(start: Date, end: Date, mode: "selected" | "daily"): Promise<Candidate[]> {
  const eventAt = mode === "daily"
    ? sql`greatest(p.timeline_at, p.public_ready_at, CASE WHEN p.policy_id = 'aihot-ai-article'
        THEN p.visible_after ELSE first_qualified.at END)`
    : sql`greatest(p.timeline_at, p.public_ready_at, p.visible_after)`;
  const admission = mode === "daily" ? sql`(
    (p.policy_id = 'aihot-ai-article' AND p.selected AND p.visible_after IS NOT NULL)
    OR (p.policy_id = 'dailynews-non-ai-fact' AND p.fact_id IS NOT NULL
      AND fes.representative_article_id = p.article_id AND fes.primary_category = p.category
      AND d.id = fes.decision_id AND d.policy_id = 'dailynews-non-ai-fact'
      AND d.primary_category = p.category AND d.representative_article_id = p.article_id
      AND d.importance_tier IS NOT NULL AND d.importance_tier <> 'noise'
      AND d.evaluated_at <= ${end} AND first_qualified.at IS NOT NULL)
  )` : sql`p.selected AND p.visible_after IS NOT NULL`;
  const rows = await sql.begin("isolation level read committed", async (tx) => {
    // Match the publication lock order: an in-flight revision or fact decision must finish before
    // this cutoff snapshot, and a later publication must wait for the candidate read to finish.
    await tx`SELECT pg_advisory_xact_lock(hashtext('dailynews-editorial-projection'))`;
    await tx`SELECT pg_advisory_xact_lock(hashtext('report_candidates'))`;
    return tx<{
      id: string; title: string; summary: string | null; url: string; category: string | null; score: number | null; first_party: boolean;
      source_id: string; source_name: string; source_kind: string; fact_public_id: string | null; story_public_id: string | null;
      at: Date; event_at: Date; policy_id: string;
    }[]>`
      SELECT p.article_id AS id, p.title, p.summary, p.url, p.category,
             CASE WHEN p.policy_id = 'dailynews-non-ai-fact' THEN d.score ELSE p.score END AS score,
             p.first_party, s.id AS source_id, s.name AS source_name,
             s.kind AS source_kind, f.public_id AS fact_public_id, st.public_id::text AS story_public_id,
             p.timeline_at AS at, ${eventAt} AS event_at, p.policy_id
      FROM publications p JOIN sources s ON s.id = p.source_id
      LEFT JOIN facts f ON f.id = p.fact_id LEFT JOIN stories st ON st.id = f.story_id
      LEFT JOIN fact_editorial_state fes ON fes.fact_id = p.fact_id
      LEFT JOIN editorial_decisions d ON d.id = fes.decision_id
      LEFT JOIN LATERAL (
        SELECT min(prior.evaluated_at) AS at FROM editorial_decisions prior
        WHERE prior.scope = 'fact' AND prior.subject_id = p.fact_id::text
          AND prior.policy_id = 'dailynews-non-ai-fact' AND prior.primary_category = p.category
          AND prior.representative_article_id = p.article_id
          AND prior.importance_tier IS NOT NULL AND prior.importance_tier <> 'noise'
      ) first_qualified ON true
      WHERE p.visibility = 'public' AND p.eligible AND NOT p.backfill AND p.public_ready_at IS NOT NULL
        AND ${currentDecisionCondition()} AND ${admission}
        AND ${eventAt} >= ${start} AND ${eventAt} < ${end}`;
  });
  // One entry per fact. Scores are only comparable inside one policy; a cross-policy tie uses
  // first-hand evidence, report time and a stable ID instead.
  const byFact = new Map<string, Candidate & { policyId: string }>();
  for (const r of rows) {
    const key = r.fact_public_id ?? `a:${r.id}`;
    const c: Candidate & { policyId: string } = {
      itemId: r.id, factId: r.fact_public_id, storyPublicId: r.story_public_id, title: r.title, summary: r.summary ?? "",
      sourceName: r.source_name, sourceUrl: r.url, sourceId: r.source_id, firstParty: r.first_party, role: roleOf(r.source_kind, r.first_party),
      score: r.score === null ? null : Number(r.score), publishedAt: r.at.toISOString(), category: r.category,
      factKey: key, eventAt: r.event_at.toISOString(), policyId: r.policy_id,
    };
    const prev = byFact.get(key);
    const firstParty = Number(c.firstParty) - Number(prev?.firstParty ?? false);
    const samePolicyScore = prev?.policyId === c.policyId ? (c.score ?? -1) - (prev.score ?? -1) : 0;
    if (!prev || firstParty > 0 || (firstParty === 0 && (samePolicyScore > 0 ||
      (samePolicyScore === 0 && (c.eventAt > prev.eventAt || (c.eventAt === prev.eventAt && c.itemId < prev.itemId)))))) byFact.set(key, c);
  }
  return [...byFact.values()].map(({ policyId: _policy, ...candidate }) => candidate)
    .sort((a, b) => b.eventAt.localeCompare(a.eventAt) || a.itemId.localeCompare(b.itemId));
}

/** Selected articles for weekly/monthly reports, retaining their existing coverage limit. */
export function candidates(start: Date, end: Date): Promise<Candidate[]> {
  return reportCandidates(start, end, "selected");
}

/** AI selections plus every current, non-noise non-AI fact's public representative. */
export function dailyCandidates(start: Date, end: Date): Promise<Candidate[]> {
  return reportCandidates(start, end, "daily");
}

/** Facts and items already covered by recent editions are not repeated. */
async function recentlyCovered(kind: "daily", before: string, days = 7): Promise<Set<string>> {
  const rows = await sql<{ content: Record<string, any> }[]>`
    SELECT content FROM reports WHERE kind = ${kind} AND key < ${before} AND key >= ${addDays(before, -days)}`;
  const out = new Set<string>();
  for (const r of rows) {
    for (const s of r.content.sections ?? []) for (const it of s.items ?? []) {
      if (it.itemId) out.add(`a:${it.itemId}`);
      if (it.factId) out.add(it.factId);
      if (it.clusterId) out.add(`c:${it.clusterId}`);
    }
  }
  return out;
}

const LeadSchema = z.object({
  title: z.string().max(120),
  leadParagraph: z.string().max(600),
  highlights: z.array(z.union([z.number(), z.string()])).max(6).catch([]),
});

async function writeLead(kind: string, key: string, entries: Candidate[], model: string) {
  const list = entries.slice(0, 30).map((e, i) =>
    `${i + 1}. [${SECTION_OF[e.category ?? ""] ?? DEFAULT_SECTION}] ${e.title}｜${e.summary.slice(0, 120)}`).join("\n");
  const res = await chatJson({
    model, purpose: "report_lead", subject: `report:${kind}:${key}`, promptVersion: REPORT_VERSION,
    system: promptText("report-daily-lead"),
    user: list, schema: LeadSchema, temperature: 0.3, maxTokens: 800,
  });
  const highlights = res.data.highlights
    .map((h) => entries[Number(h) - 1])
    .filter((e): e is Candidate => !!e)
    .map((e) => e.itemId);
  return { lead: { title: res.data.title, leadParagraph: res.data.leadParagraph }, highlights, receiptId: res.receiptId };
}

type ReportKind = "daily" | "weekly" | "monthly";
const automatic = (reason: string) => reason === "scheduled" || reason === "catch-up";

async function savedReport(kind: ReportKind, key: string) {
  const [row] = await sql<{ revision: number; entries: number }[]>`
    SELECT revision, CASE WHEN kind = 'daily' THEN coalesce((content->'metrics'->>'totalEvents')::int, 0)
      ELSE coalesce(jsonb_array_length(content->'storyOrder'), (content->'metrics'->>'totalStories')::int, 0) END AS entries
    FROM reports WHERE kind = ${kind} AND key = ${key}`;
  return row;
}

function entryOf({ category: _category, factKey: _factKey, eventAt: _eventAt, ...entry }: Candidate): ReportEntry {
  return entry;
}

/** Cover every represented category once, then fill by category rotation; never compare policy scores across categories. */
export function selectDailyCandidates(fresh: Candidate[], limit = 24): Candidate[] {
  const queues = CATEGORIES.map(({ key }) => fresh.filter((candidate) => candidate.category === key)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.eventAt.localeCompare(a.eventAt) || a.itemId.localeCompare(b.itemId)));
  const selected: Candidate[] = [];
  const facts = new Set<string>();
  while (selected.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      while (queue.length && facts.has(queue[0]!.factKey)) queue.shift();
      const next = queue.shift();
      if (!next) continue;
      selected.push(next);
      facts.add(next.factKey);
      if (selected.length >= limit) break;
    }
  }
  return selected.sort((a, b) => b.eventAt.localeCompare(a.eventAt) || a.itemId.localeCompare(b.itemId));
}

async function saveReport(kind: ReportKind, key: string, start: Date, end: Date, content: Record<string, unknown>, reason: string, model: string, receiptId: number, expectedRevision: number) {
  await sql.begin(async (tx) => {
    // The row may not exist yet. Serialize only the commit; model calls hold no transaction open.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`report:${kind}:${key}`}))`;
    const [existing] = await tx<{ id: number; revision: number; content: unknown; generated_at: Date }[]>`
      SELECT id, revision, content, generated_at FROM reports WHERE kind = ${kind} AND key = ${key} FOR UPDATE`;
    if (existing && automatic(reason)) {
      await completeReceipt(tx, receiptId);
      return;
    }
    if ((existing?.revision ?? 0) !== expectedRevision) throw new Conflict("报告已有新的修订，请刷新后再纠错");
    if (existing) {
      await tx`INSERT INTO report_revisions (report_id, revision, content, generated_at, reason)
               VALUES (${existing.id}, ${existing.revision}, ${tx.json(existing.content as never)}, ${existing.generated_at}, ${reason}) ON CONFLICT DO NOTHING`;
      await tx`UPDATE reports SET content = ${tx.json(content as never)}, window_start = ${start}, window_end = ${end}, generated_at = now(),
                 model = ${model}, revision = revision + 1, origin = 'model', updated_at = now() WHERE id = ${existing.id}`;
    } else {
      await tx`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, model, origin)
               VALUES (${kind}, ${key}, ${start}, ${end}, ${tx.json(content as never)}, now(), ${model}, 'model')`;
    }
    await completeReceipt(tx, receiptId);
  });
}

/** Daily report for Beijing date D covers [D-1 08:00, D 08:00) Beijing time. */
export async function composeDaily(date: string, reason = "scheduled"): Promise<{ key: string; entries: number }> {
  const previous = await savedReport("daily", date);
  if (previous && automatic(reason)) return { key: date, entries: previous.entries };
  const end = new Date(beijingMidnight(date).getTime() + 8 * 3600 * 1000);
  const start = new Date(end.getTime() - 86400000);
  const covered = await recentlyCovered("daily", date);
  const all = await dailyCandidates(start, end);
  const fresh = all.filter((c) => !covered.has(c.factKey) && !covered.has(`a:${c.itemId}`));
  const chosen = selectDailyCandidates(fresh);
  const perSection = new Map<string, Candidate[]>();
  for (const c of chosen) {
    const label = SECTION_OF[c.category ?? ""] ?? DEFAULT_SECTION;
    const list = perSection.get(label) ?? [];
    list.push(c);
    perSection.set(label, list);
  }
  const sections = SECTION_ORDER.filter((l) => perSection.get(l)?.length).map((label) => ({
    label,
    items: perSection.get(label)!.map(entryOf),
  }));
  const ordered = chosen.map(entryOf);
  // An issue with nothing in it is a failure upstream, not a report: the run fails and is caught up later.
  if (ordered.length === 0) throw new Error(`daily ${date}: no selected items in its window`);
  const model = await modelFor("report");
  const lead = await writeLead("daily", date, chosen, model);
  const content = {
    date,
    lead: lead.lead,
    highlights: lead.highlights,
    sections,
    storyOrder: chosen.map((candidate) => candidate.itemId),
    flashes: [],
    metrics: {
      totalEvents: ordered.length,
      sourcesCount: new Set(ordered.map((e) => e.sourceId)).size,
      firstPartyEvents: ordered.filter((e) => e.firstParty).length,
    },
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    generator: { version: REPORT_VERSION, model, repeatsSuppressed: all.length - fresh.length },
  };
  await saveReport("daily", date, start, end, content, reason, model, lead.receiptId, previous?.revision ?? 0);
  return { key: date, entries: ordered.length };
}

export const PeriodSchema = z.object({
  // A headline is asked for, but a missing or unusable one leaves the issue on its generic name.
  headline: z.string().max(60).catch(""),
  overview: z.string().max(1500),
  themes: z
    // A theme cites at most eight entries; a model that lists more keeps its first eight rather than failing the issue.
    .array(z.object({ heading: z.string().max(60), summary: z.string().max(800), refs: z.array(z.union([z.number(), z.string()])).transform((refs) => refs.slice(0, 8)) }))
    .min(1)
    .transform((themes) => themes.slice(0, 6)),
});

/** The editor's brief for a week or month: its top entries as a numbered list, each with its section. */
export function periodPrompt(kind: "weekly" | "monthly", startDate: string, endDateInclusive: string, top: Candidate[]) {
  const list = top.map((e, i) => `${i + 1}. [${SECTION_OF[e.category ?? ""] ?? DEFAULT_SECTION}] ${e.title}｜${e.summary.slice(0, 140)}`).join("\n");
  return {
    system: promptText("report-period", { kindName: kind === "weekly" ? "周报" : "月报", overviewLength: kind === "weekly" ? "150–300" : "200–400" }),
    user: `本期：${startDate} 至 ${endDateInclusive}\n${list}`,
  };
}

async function composePeriod(kind: "weekly" | "monthly", key: string, startDate: string, endDateInclusive: string, reason: string) {
  const previous = await savedReport(kind, key);
  if (previous && automatic(reason)) return { key, entries: previous.entries };
  const start = beijingMidnight(startDate);
  const end = beijingMidnight(addDays(endDateInclusive, 1));
  const all = await candidates(start, end);
  const top = all.slice(0, kind === "weekly" ? 40 : 60);
  const dailyCount = (await sql<{ n: number }[]>`SELECT count(*) AS n FROM reports WHERE kind = 'daily' AND key >= ${startDate} AND key <= ${endDateInclusive}`)[0]?.n ?? 0;
  if (!top.length) throw new Error(`${kind} ${key}: no selected items in the period`);
  const model = await modelFor("report");
  const res = await chatJson({
    model, purpose: `report_${kind}`, subject: `report:${kind}:${key}`, promptVersion: REPORT_VERSION,
    ...periodPrompt(kind, startDate, endDateInclusive, top), schema: PeriodSchema, temperature: 0.3, maxTokens: 2500,
  });
  const headline = res.data.headline.trim();
  const themes = res.data.themes
    .map((t) => ({
      heading: t.heading,
      summary: t.summary,
      storyRefs: t.refs.map((r) => top[Number(r) - 1]).filter((e): e is Candidate => !!e).map(entryOf),
    }))
    // Only references to the listed items count; a theme citing none of them is dropped.
    .filter((t) => t.storyRefs.length > 0);
  if (!themes.length) {
    // Nothing it wrote is about this period's items: the next attempt asks again (and pays again).
    await rejectReceivedResponse(res.receiptId, "no theme cites a listed item");
    throw new ModelOutputError(`${kind} ${key}: no theme cites a listed item`);
  }
  const content = {
    kind,
    title: kind === "weekly" ? `${SITE.name} 周报 · ${key}` : `${SITE.name} 月报 · ${key}`,
    ...(kind === "weekly" ? { isoLabel: key } : { monthLabel: key }),
    periodStart: startDate,
    periodEnd: endDateInclusive,
    ...(headline ? { headline } : {}),
    overview: res.data.overview,
    themes,
    storyOrder: top.map((e) => e.itemId),
    metrics: { totalStories: themes.reduce((n, t) => n + t.storyRefs.length, 0), selectedCount: all.length, reportsCovered: Number(dailyCount) },
    generator: { version: REPORT_VERSION, model },
  };
  await saveReport(kind, key, start, end, content, reason, model, res.receiptId, previous?.revision ?? 0);
  return { key, entries: top.length };
}

export async function composeWeekly(label: string, reason = "scheduled") {
  const range = isoWeekRange(label);
  if (!range) throw new Error(`bad week label ${label}`);
  return composePeriod("weekly", label, range.start, range.end, reason);
}

export async function composeMonthly(label: string, reason = "scheduled") {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) throw new Error(`bad month label ${label}`);
  const start = `${label}-01`;
  const next = Number(m[2]) === 12 ? `${Number(m[1]) + 1}-01-01` : `${m[1]}-${String(Number(m[2]) + 1).padStart(2, "0")}-01`;
  return composePeriod("monthly", label, start, addDays(next, -1), reason);
}

const bjParts = (now: Date) => {
  const iso = new Date(now.getTime() + 8 * 3600000).toISOString();
  return { hour: Number(iso.slice(11, 13)), minute: Number(iso.slice(14, 16)) };
};

/** The newest daily due by `now`: today's from 08:00 Beijing time, yesterday's before. */
export function dueDaily(now = new Date()): string {
  const today = beijingDate(now);
  return bjParts(now).hour >= 8 ? today : addDays(today, -1);
}

/** The newest weekly due by `now`: the last complete ISO week from Monday 10:00, the one before until then. */
export function dueWeekly(now = new Date()): string {
  const today = beijingDate(now);
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const due = dow > 0 || bjParts(now).hour >= 10;
  return isoWeekLabel(addDays(today, -dow - (due ? 7 : 14)));
}

/** The newest monthly due by `now`: the last complete month from the 1st 10:30, the one before until then. */
export function dueMonthly(now = new Date()): string {
  const [y, m, d] = beijingDate(now).split("-").map(Number) as [number, number, number];
  const { hour, minute } = bjParts(now);
  const due = d > 1 || hour > 10 || (hour === 10 && minute >= 30);
  const back = due ? 1 : 2;
  const month = (y * 12 + (m - 1) - back);
  return `${Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, "0")}`;
}

const nextWeek = (label: string) => isoWeekLabel(addDays(isoWeekRange(label)!.start, 7));
const nextMonth = (label: string) => {
  const [y, m] = label.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/**
 * Catch-up (hourly): every issue due since the first of its kind that does not exist yet, oldest first,
 * as the legacy recovery did — a long stop or an older gap is filled too, not only the last week. A kind
 * with no issue yet only gets its latest due one. An issue that fails does not hold up the others; at
 * most `limit` issues are written per run, the next run continues.
 */
export async function catchUpReports(now = new Date(), limit = 8): Promise<{ generated: string[]; failed: string[] }> {
  const generated: string[] = [];
  const failed: string[] = [];
  const kinds: Array<{ kind: "daily" | "weekly" | "monthly"; due: string; next: (k: string) => string; compose: (k: string, reason: string) => Promise<unknown> }> = [
    { kind: "daily", due: dueDaily(now), next: (k) => addDays(k, 1), compose: composeDaily },
    { kind: "weekly", due: dueWeekly(now), next: nextWeek, compose: composeWeekly },
    { kind: "monthly", due: dueMonthly(now), next: nextMonth, compose: composeMonthly },
  ];
  kinds: for (const k of kinds) {
    const have = new Set((await sql<{ key: string }[]>`SELECT key FROM reports WHERE kind = ${k.kind}`).map((r) => r.key));
    const first = [...have].sort()[0] ?? k.due;
    for (let key = first; key <= k.due; key = k.next(key)) {
      if (have.has(key)) continue;
      if (shutdownSignal.signal.aborted || generated.length >= limit) break kinds;
      try {
        await k.compose(key, "catch-up");
        generated.push(`${k.kind}:${key}`);
      } catch (error) {
        failed.push(`${k.kind}:${key}`);
        console.error(JSON.stringify({ level: "error", msg: "report catch-up failed", report: `${k.kind}:${key}`, error: String(error).slice(0, 300) }));
      }
    }
  }
  if (failed.length) throw new Error(`report catch-up: ${failed.join(", ")} failed${generated.length ? `; ${generated.join(", ")} written` : ""}`);
  return { generated, failed };
}
