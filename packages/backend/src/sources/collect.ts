// Collection run for one source: fetch listing → filter → store material → enqueue processing.
// A failed fetch never advances the success cursor; the source's health reflects consecutive failures.
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { contentHash, identityKeyFor, upsertMaterial } from "../content/materials.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { enqueue, getBoss, QUEUES, shutdownSignal } from "../jobs/queue.ts";
import { queueProcessing } from "../jobs/content.ts";
import { admitArticle, assertTrialRuntime, beginTrialSource } from "../dailynews/trial.ts";
import { BudgetExceededError, ReceiptUnknownError, completeReceipt } from "../providers/receipts.ts";
import { fetchRss } from "./rss.ts";
import { allowed, fetchDetail, fetchWebList, type DetailNeed } from "./web-list.ts";
import { unsupportedConfig } from "./config-keys.ts";
import { fetchJsonList } from "./json-list.ts";
import { fetchSitemap } from "./sitemap.ts";
import { fetchOfficialX } from "./x-official.ts";
import { fetchFirecrawlFallback, firecrawlFallbackEnabled } from "./firecrawl-fallback.ts";
import { fetchXSearch, planXShards, readXSearch, shardHandle, shardQuery, SHARDABLE_SQL, tweetToCandidate, type XBacklog } from "./x.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";
import { collectionDomain } from "../lib/collection-domain.ts";
import { withRequestDeadline, currentRequestSignal } from "../lib/request-scope.ts";
import { receiveCollection, initializedBaseline, publishedAfterInitialization, skipBeforeInitialization, type IntakeCandidate } from "./intake.ts";

export interface CollectResult {
  sourceId: string;
  status: "ok" | "failed" | "skipped";
  found: number;
  created: number;
  revised: number;
  error?: string;
  pending?: boolean;
  trial?: { id: string; admittedNormal: number; admittedBackfill: number; notAdmitted: number; unchanged: number };
}


export function noiseFiltered(c: Candidate, source: SourceRow): boolean {
  const f = source.config.ingestNoiseFilter;
  const cats: string[] = c.categories ?? [];
  if (source.config.denyCategories?.some((d: string) => cats.includes(d))) return true;
  if (source.config.allowCategories?.length && !source.config.allowCategories.some((a: string) => cats.includes(a))) return true;
  if (!f) return false;
  // Case-insensitive: the exemption "agent" keeps "Agent" (words in the lists are lower case).
  const has = (text: string, words: string[] | undefined) => (words ?? []).some((k) => text.includes(k.toLowerCase()));
  const title = c.title.toLowerCase();
  const hay = `${title}\n${(c.excerpt ?? "").toLowerCase()}`;
  if (has(hay, f.keepIfMatches)) return false;
  return has(title, f.dropMarkersTitleOnly) || has(hay, f.dropMarkers);
}

function rewriteUrl(c: Candidate, source: SourceRow): Candidate {
  const rw = source.config.itemUrlPrefixRewrite;
  if (rw?.from && rw?.to && c.url.startsWith(rw.from)) return { ...c, url: rw.to + c.url.slice(rw.from.length) };
  return c;
}

async function loadSource(id: string): Promise<SourceRow | null> {
  const [s] = await sql<SourceRow[]>`
    SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
    FROM sources WHERE id = ${id}`;
  return s ?? null;
}

interface StoredListing {
  title: string; source_id: string; source_updated_at: Date | null;
  source_detail_checked_at: Date | null; source_listing_signature: string | null; discovered_at: Date;
}
async function storedTitles(identities: string[]): Promise<Map<string, StoredListing>> {
  if (identities.length === 0) return new Map();
  const rows = await sql<(StoredListing & { identity_key: string })[]>`
    SELECT identity_key, title, source_id, source_updated_at, source_detail_checked_at,
      source_listing_signature, discovered_at FROM articles WHERE identity_key = ANY(${identities}::text[])`;
  return new Map(rows.map((r) => [r.identity_key, r]));
}
function listingSignature(candidate: Candidate): string {
  const updated = candidate.sourceUpdatedAt;
  return sha256(contentHash(candidate) + "\u0001" + (updated && Number.isFinite(updated.getTime()) ? updated.toISOString() : ""));
}

const DAY_MS = 86_400_000;
export const BOUNDED_TRIAL_CANDIDATES_PER_SOURCE = 100;

/** Old items missed by a first-import slice are never recast as normal new material. */
export function boundedIncrementalCandidates(candidates: Candidate[], baseline: Date, dateFromDetail: boolean): Candidate[] {
  return candidates.filter((c) => dateFromDetail || !c.publishedAt || c.publishedAt > baseline)
    .slice(0, BOUNDED_TRIAL_CANDIDATES_PER_SOURCE);
}

/** A listing title that is no headline: a label that swallowed its summary, or a call to action. */
const needsTitle = (title: string) => title.length > 100 || /^(read more|learn more|continue reading|more|阅读全文|阅读更多|查看详情|了解更多)$/i.test(title.trim());

async function store(sourceId: string, candidates: Candidate[], backfill: string | null, trialId: string | null, runId?:number, cursor?:Record<string,unknown> | null, baselineGate=false): Promise<{
  created: number; revised: number; admittedNormal: number; admittedBackfill: number; notAdmitted: number; unchanged: number; baselineSkipped: number;
}> {
  let created = 0;
  let revised = 0;
  let admittedNormal = 0;
  let admittedBackfill = 0;
  let notAdmitted = 0;
  let unchanged = 0;
  let baselineSkipped = 0;
  for (const c of candidates) {
    const material = { ...c, sourceId, via: "fetch" as const, backfill };
    // In a bounded trial, an interrupted admission must not leave a committed article that
    // the next fetch treats as unchanged and therefore never admits. Keep the material and
    // its immutable ledger entry in the same transaction; queueing can resume from that ledger.
    const storedResult=await sql.begin(async tx=>{
      if(runId){
        await tx`SELECT pg_advisory_xact_lock(hashtext('collection-source'),hashtext(${sourceId}))`;
        const [owner]=await tx`SELECT collection_run_id FROM sources WHERE id=${sourceId}`;
        if(Number(owner?.collection_run_id)!==Number(runId))throw new Error("collection run superseded");
      }
      if (baselineGate && await skipBeforeInitialization(tx,c,sourceId,cursor ?? null,backfill)) return null;
      const res=await upsertMaterial(material,tx);
      const lane=res.backfill?"backfill":"normal";
      const admission=trialId&&(res.created||res.revised)?await admitArticle(res.articleId,{lane},tx):null;
      if(admission&&!admission.admitted&&admission.reason!=="quota"&&admission.reason!=="not-new")throw new Error(`bounded trial admission failed: ${admission.reason}`);
      if((res.created||res.revised)&&(!admission||admission.admitted))await queueProcessing(res.articleId,{db:tx});
      return {res,admission,lane};
    });
    if (!storedResult) { baselineSkipped++; continue; }
    const {res,admission,lane}=storedResult;
    if (res.created) created += 1;
    if (res.revised) revised += 1;
    if (!res.created && !res.revised) { unchanged += 1; continue; }
    if (admission) {
      if (!admission.admitted) { notAdmitted += 1; continue; }
      if (admission.reason === "admitted") {
        if (lane === "normal") admittedNormal += 1;
        else admittedBackfill += 1;
      }
    }
    // Extraction first when the source wants full text and none came with the listing, else analysis.

  }
  return { created, revised, admittedNormal, admittedBackfill, notAdmitted, unchanged, baselineSkipped };
}

export function collectSource(sourceId: string, opts: { force?: boolean; trialId?: string; deferred?: boolean } = {}): Promise<CollectResult> {
  return withRequestDeadline(480_000,shutdownSignal.signal,()=>collectSourceRun(sourceId,opts));
}
async function collectSourceRun(sourceId:string,opts:{force?:boolean;trialId?:string;deferred?:boolean}):Promise<CollectResult> {
  // Query the persisted boundary even when env was omitted: an existing trial DB may never
  // become an unrestricted collector by starting this entrypoint without its runtime flags.
  const trial = await assertTrialRuntime(sql);
  const bounded = trial !== null;
  const trialId = opts.trialId ?? trial?.id ?? null;
  if (bounded && !trialId || trialId && (!bounded || trialId !== process.env.DAILYNEWS_TRIAL_ID))
    throw new Error("bounded trial ID and runtime mode must agree");
  if (trial && trial.status !== "open")
    return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "trial frozen" };
  const source = await loadSource(sourceId);
  if (!source) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "missing" };
  if (!source.enabled && !opts.force) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "paused" };
  // Import inventory is intentionally inert, including forced previews, until a reviewed pilot
  // explicitly marks this section verified and enables its source row.
  if (source.config.dailyNews?.migrationStatus !== undefined && source.config.dailyNews.migrationStatus !== "verified")
    return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "migration unverified" };
  if (source.kind === "mp_account" || source.kind === "external") {
    // WeChat accounts are reconciled by the mp job; external sources only receive reports.
    return { sourceId, status: "skipped", found: 0, created: 0, revised: 0 };
  }

  // This is the first *actual* source attempt, not manifest creation or preflight. The trial API
  // atomically freezes this timestamp (or the source's existing initializedAt) before network I/O.
  const trialBaseline = trialId ? await beginTrialSource(sourceId, sql) : null;
  if (trialId && !trialBaseline) throw new Error("bounded trial source has no baseline");

  const run = await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('collection-source'),hashtext(${sourceId}))`;
    const [locked]=await tx<SourceRow[]>`SELECT * FROM sources WHERE id=${sourceId} FOR UPDATE`;
    if(!locked)return null;
    Object.assign(source,locked);
    const [active] = await tx`SELECT f.id FROM sources s JOIN fetch_runs f ON f.id=s.collection_run_id
      WHERE s.id=${sourceId} AND f.status='running' AND
      (f.started_at>now()-interval '10 minutes' OR EXISTS(SELECT 1 FROM collection_intakes i WHERE i.run_id=f.id AND i.finished_at IS NULL))`;
    if(active)return null;
    const [created]=await tx<{id:number}[]>`INSERT INTO fetch_runs(source_id) VALUES (${sourceId}) RETURNING id`;
    await tx`UPDATE sources SET collection_run_id=${created!.id} WHERE id=${sourceId}`;
    return created!;
  });
  if(!run)return {sourceId,status:"skipped",found:0,created:0,revised:0,error:"collection pending"};
  const fetchStarted=performance.now();
  const baselineGate = source.config.dailyNews !== undefined;
  const baseline = initializedBaseline(source.cursor);
  const firstImport = baseline === null;
  const initializedAt = new Date().toISOString();
  let baselineSkipped = 0;
  let created = 0;
  let revised = 0;
  let found = 0;
  let trialCounts = { admittedNormal: 0, admittedBackfill: 0, notAdmitted: 0, unchanged: 0 };
  try {
    // A config entry this kind does not implement fails the run, visibly, instead of being ignored.
    const unsupported = unsupportedConfig(source.kind, source.config);
    if (unsupported.length) throw new FetchError(`unsupported config: ${unsupported.join(", ")}`);
    let candidates: Candidate[];
    let paidReceiptIds: number[] = [];
    let nextCursor: Record<string, unknown> = { ...(source.cursor ?? {}) };
    let detail: Record<string, unknown> | null = null;
    if (source.kind === "x_search" && source.config.dailyNews?.adapter === "x_official") {
      const x = await fetchOfficialX(source);
      candidates = x.candidates;
      nextCursor.officialX = x.cursor;
      detail = { pages: x.pages, partial: x.partial, provider: "official_x_v2" };
    } else if (source.kind === "x_search") {
      const x = await fetchXSearch(source);
      candidates = x.candidates;
      paidReceiptIds = x.receiptIds;
      if (x.lastId) nextCursor.lastTweetId = x.lastId;
      // A search longer than one run keeps its position for the next runs (shown in the admin).
      if (x.backlog.length) nextCursor.xBacklog = x.backlog;
      else delete nextCursor.xBacklog;
      detail = { pages: x.pages, truncated: x.truncated, backlog: x.backlog.length, backlogPages: x.backlogPages, dropped: x.dropped };
    } else {
      let directError: unknown;
      let notModified = false;
      try {
        if (source.kind === "rss") {
          // Feed validators say nothing about independent edits on article pages. Sources with a
          // detail budget occasionally reread the full listing so the existing bounded 72h recheck
          // can see its URLs. Commit this clock only with the source's normal success cursor.
          const detailRecheck = !!source.config.detail && Number(source.config.detail.maxFetches ?? 0) > 0;
          const lastFullRead = Date.parse(String(source.cursor?.rssFullReadAt ?? ""));
          const fullReadDue = !firstImport && detailRecheck &&
            (!Number.isFinite(lastFullRead) || Date.now() - lastFullRead >= 6 * 3600_000);
          const rss = await fetchRss(source, { force: opts.force || fullReadDue });
          if (detailRecheck && !rss.notModified) nextCursor.rssFullReadAt = new Date().toISOString();
          candidates = rss.candidates;
          if (!firstImport) nextCursor.rss = rss.validator;
          else delete nextCursor.rss;
          notModified = rss.notModified;
          if (notModified) detail = { notModified: true, httpStatus: 304 };
        } else if (source.kind === "web_list" && source.config.dailyNews?.adapter === "sitemap") {
          const sitemap = await fetchSitemap(source);
          candidates = sitemap.candidates;
          detail = { documents: sitemap.documents, provider: "sitemap" };
        } else if (source.kind === "web_list") candidates = await fetchWebList(source);
        else candidates = await fetchJsonList(source);
      } catch (error) {
        directError = error;
        candidates = [];
      }
      if (!notModified && candidates.length === 0 && firecrawlFallbackEnabled(source)) {
        const fallback = await fetchFirecrawlFallback(source);
        candidates = fallback.candidates;
        paidReceiptIds.push(fallback.receiptId);
        detail = { provider: "firecrawl_news_search", directError: directError ? String(directError).slice(0, 300) : null };
      } else if (directError) throw directError;
      if (directError && candidates.length === 0) throw directError;
    }
    found = candidates.length;
    candidates = candidates.filter((c) => allowed(c.url, source)).map((c) => rewriteUrl(c, source)).filter((c) => !noiseFiltered(c, source));
    if (source.config.sortByPublishedAt) candidates.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
    // Deduplicate before enrichment and limits: URL aliases must neither buy duplicate detail reads
    // nor crowd other articles out of the window. Use exactly the identity the material will store.
    const unique = new Map<string, Candidate>();
    for (const c of candidates) {
      const identityKey = c.identityKey
        ?? (source.config.preserveUrlFragment === true ? identityKeyForUrl(c.url, { keepFragment: true }) : null)
        ?? identityKeyFor({ ...c, sourceId, via: "fetch" });
      if (!unique.has(identityKey)) unique.set(identityKey, { ...c, identityKey });
    }
    candidates = [...unique.values()];
    // Identity checks precede history filtering, so already stored pages can still be corrected.
    const known = await storedTitles(candidates.map((c) => c.identityKey!));
    // First import of a new source: bounded, and archived by source time (never "today", never pushed).
    const backfillLimit = Number(source.config._aihot?.initialBackfillLimit ?? 30);
    const backfillMonths = Number(source.config._aihot?.initialBackfillMonths ?? 12);
    if (firstImport) {
      const cutoff = Date.now() - backfillMonths * 30 * 86400000;
      candidates = candidates.filter((c) => !c.publishedAt || !Number.isFinite(c.publishedAt.getTime()) || c.publishedAt.getTime() >= cutoff).slice(0, backfillLimit);
    } else if (trialBaseline) {
      // A source's initial import is history regardless of timestamp. Later listings can be huge
      // (OpenAI's feed has >1,000 entries); old published material is never a trial "new" item.
      // When the feed's date is not authoritative, the detail rule checks the article page below.
      candidates = [...candidates.filter(c=>known.has(c.identityKey!)), ...boundedIncrementalCandidates(candidates.filter(c=>!known.has(c.identityKey!)), trialBaseline, source.config.detail?.publishedAtAuthoritative === true)];
    }
    if (baselineGate && !firstImport && baseline) {
      const before = candidates.length;
      candidates = candidates.filter((c) => known.has(c.identityKey!) ||
        (source.config.detail?.publishedAtAuthoritative !== true && publishedAfterInitialization(c,baseline)) ||
        (!!source.config.detail && Number(source.config.detail.maxFetches ?? 0) > 0 &&
          (source.config.detail.publishedAtAuthoritative === true || !c.publishedAt)));
      baselineSkipped += before - candidates.length;
    }
    // Process all admitted listing records before advancing the success cursor.

    // Detail pages only for material we have not seen (bounded per run), and only for what the listing lacks.
    const d = source.config.detail;
    const detailBudget = Number(d?.maxFetches ?? 0);
    let detailUsed = 0;
    const intake: IntakeCandidate[] = [];
    for (const c of candidates) {
      currentRequestSignal()?.throwIfAborted();
      intake.push({candidate:c,need:null});
      // Listing dates the source marks unreliable are dropped; the detail page's rule decides.
      if (d?.publishedAtAuthoritative === true) c.publishedAt = null;
      const stored = known.get(c.identityKey!);
      // Hash the original listing before restoring a title obtained from the authoritative page.
      c.listingSignature = listingSignature(c);
      const now = Date.now();
      const recent = stored && now - stored.discovered_at.getTime() <= 72 * 3600_000;
      const recheck = stored && stored.source_id === sourceId && (
        stored.source_listing_signature !== c.listingSignature ||
        recent && now - (stored.source_detail_checked_at ?? stored.discovered_at).getTime() >= 6 * 3600_000);
      if (stored !== undefined) {
        // Failed/budget-deferred checks keep the authoritative title until detail confirms a change.
        if (d?.titleSelector || d?.titleRegex) c.title = stored.title;
        if (!recheck) continue;
      }
      if (!d || detailUsed >= detailBudget) continue;
      const need: DetailNeed = {
        date: !c.publishedAt || d.upgradeDatePrecision === true,
        title: !!(d.titleSelector || d.titleRegex) && (!!recheck || d.titleAuthoritative === true || needsTitle(c.title)),
        summary: !!d.summarySelector && (!!recheck || !c.excerpt),
        body: source.participation_mode === "editorial" && !c.bodyText && (!!recheck || !c.bodyStatus || c.bodyStatus === "pending"),
      };
      if (!need.date && !need.title && !need.summary && !need.body) continue;
      detailUsed += 1;
      if(opts.deferred){intake[intake.length-1]!.need=need;continue;}
      try {
        const got = await fetchDetail(c.url, source, need, { strictHttp: true });
        c.detailCheckedAt = new Date();
        if (got.title) c.title = got.title;
        if (got.summary) c.excerpt = got.summary;
        // The same Readability path as extraction, using bytes already fetched for the detail rules.
        // A confirmed body enters through normal material revisions and skips the redundant fetch job.
        if (got.body) {
          c.bodyHtml = got.body.html;
          c.bodyText = got.body.text;
          c.bodyStatus = "ok";
          if (!c.media?.length) c.media = got.body.images;
        }
        // A date-only listing value gives way to the detail page's time on the same day.
        if (got.publishedAt && (!c.publishedAt || Math.abs(got.publishedAt.getTime() - c.publishedAt.getTime()) < DAY_MS)) c.publishedAt = got.publishedAt;
      } catch(error) {
        if(error instanceof BudgetExceededError || error instanceof ReceiptUnknownError)throw error;
        // detail is best effort
      }
    }

    currentRequestSignal()?.throwIfAborted();
    if(opts.deferred) {
      delete nextCursor.jinaListingRound;
      if(firstImport)nextCursor.initializedAt=initializedAt;
      nextCursor.lastOkAt=new Date().toISOString();
      const stages={fetchMs:Math.round(performance.now()-fetchStarted),received:candidates.length,detailQueued:intake.filter(i=>i.need).length};
      await sql`UPDATE fetch_runs SET found_count=${found},detail=${sql.json({...detail,stages} as never)} WHERE id=${run.id}`;
      await receiveCollection(run.id,sourceId,intake,{trialId,backfill:firstImport?"first-import":null,cursor:nextCursor,receiptIds:paidReceiptIds,detail:{...detail,stages,baselineSkipped,baselineGate}});
      return {sourceId,status:"ok",found,created:0,revised:0,pending:candidates.length>0};
    }
    const stored = await store(sourceId, candidates, firstImport ? "first-import" : null, trialId ?? null, run.id, source.cursor, baselineGate);
    ({created,revised,...trialCounts} = {created:stored.created,revised:stored.revised,admittedNormal:stored.admittedNormal,admittedBackfill:stored.admittedBackfill,notAdmitted:stored.notAdmitted,unchanged:stored.unchanged});
    baselineSkipped += stored.baselineSkipped;

    // A Jina listing round that was pending when this run started has been received by now.
    delete nextCursor.jinaListingRound;
    if (firstImport) nextCursor.initializedAt = initializedAt;
    nextCursor.lastOkAt = new Date().toISOString();
    await sql.begin(async (tx) => {
      await tx`
        UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL,
          health = 'ok', cursor = ${tx.json(nextCursor as never)}, updated_at = now(),
          next_fetch_at = now() + make_interval(mins => interval_minutes)
        WHERE id = ${sourceId} AND collection_run_id=${run.id}`;
      const runDetail = trialId ? { ...(detail ?? {}), baselineSkipped, boundedTrial: { id: trialId, revised, ...trialCounts } } : baselineGate ? { ...(detail ?? {}), baselineSkipped } : detail;
      await tx`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${found}, new_count = ${created},
                  detail = ${runDetail ? tx.json(runDetail as never) : null} WHERE id = ${run!.id}`;
      for (const receiptId of paidReceiptIds) await completeReceipt(tx, receiptId);
    });
    return { sourceId, status: "ok", found, created, revised,
      ...(trialId ? { trial: { id: trialId, ...trialCounts } } : {}) };
  } catch (error) {
    if (shutdownSignal.signal.aborted) throw error;
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    const budget = error instanceof BudgetExceededError;
    await sql`
      UPDATE sources SET last_fetch_at = now(),
        fail_count = CASE WHEN ${budget} THEN fail_count ELSE fail_count + 1 END,
        last_error = ${message},
        health = CASE WHEN ${budget} THEN health WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
        next_fetch_at = now() + make_interval(mins => CASE WHEN ${budget} THEN 15 ELSE LEAST(interval_minutes * (fail_count + 2), 360) END),
        updated_at = now()
      WHERE id = ${sourceId} AND collection_run_id=${run.id}`;
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), found_count = ${found}, new_count = ${created}, error = ${message},
      detail = ${trialId ? sql.json({ boundedTrial: { id: trialId, revised, ...trialCounts } } as never) : null} WHERE id = ${run!.id}`;
    return { sourceId, status: "failed", found, created, revised, error: message,
      ...(trialId ? { trial: { id: trialId, ...trialCounts } } : {}) };
  }
}

/** X ids begin with their millisecond timestamp (since 2010-11-04): the smallest id of a post made at `ms`. */
const xIdAt = (ms: number) => (BigInt(Math.max(0, ms - 1288834974657)) << 22n);

/**
 * Where an account's posts are known to be read up to. A quiet account's newest post can be months
 * old, but its last successful check read everything up to then; bounding a shard's search by the
 * post alone would re-read months of the other accounts' posts. Ten minutes before the check allows
 * for posts that reach the search late.
 */
function coveredTo(m: SourceRow): bigint {
  const own = BigInt(m.cursor!.lastTweetId);
  const checked = Date.parse(String(m.cursor?.lastOkAt ?? ""));
  if (!Number.isFinite(checked)) return own;
  const byTime = xIdAt(checked - 10 * 60_000);
  return byTime > own ? byTime : own;
}

/** Minutes between reads of a shard: editorial accounts every half hour, hot-signal accounts hourly. */
const X_SHARD_MINUTES: Record<string, number> = { editorial: 30, hot_signal: 60 };
const shardMinutes = (mode: string) => X_SHARD_MINUTES[mode] ?? 60;

/**
 * One search for a shard of X accounts (planXShards). Each post goes to the source whose handle wrote
 * it, and every account keeps its own fetch run, health and cursor. The oldest watermark bounds the
 * search, so no account misses a post (the others only see posts they already have again); afterwards
 * every account is covered up to the newest post the search saw, and the stretches still unread are
 * kept in each account's cursor, so they survive a change of shards.
 */
export async function collectXShard(key: string, sourceIds: string[]): Promise<{ key: string; status: "ok" | "failed" | "skipped"; accounts: number; found: number; created: number; error?: string }> {
  if (await assertTrialRuntime(sql)) throw new Error("X shard collection is outside the bounded trial entrypoint");
  const members = (
    await sql<SourceRow[]>`
      SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
      FROM sources WHERE id = ANY(${sourceIds}::text[])`
  ).filter((m) => m.enabled && shardHandle(m)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (members.length === 0) return { key, status: "skipped", accounts: 0, found: 0, created: 0 };
  const minutes = shardMinutes(members[0]!.participation_mode);
  const runs = new Map((await sql<{ id: number; source_id: string }[]>`
    INSERT INTO fetch_runs ${sql(members.map(m => ({ source_id: m.id })), "source_id")} RETURNING id, source_id`
  ).map(r => [r.source_id, r.id]));
  let found = 0;
  let created = 0;
  try {
    const since = members.map(coveredTo).reduce((a, b) => (b < a ? b : a));
    const backlog: XBacklog[] = [];
    const stretches = new Set<string>();
    for (const m of members) {
      for (const b of (Array.isArray(m.cursor?.xBacklog) ? m.cursor.xBacklog : []) as XBacklog[]) {
        if (!stretches.has(`${b.query} ${b.next}`)) backlog.push(b);
        stretches.add(`${b.query} ${b.next}`);
      }
    }
    const read = await readXSearch(shardQuery(members.map((m) => shardHandle(m)!)), { lastId: String(since), backlog, subject: `x-shard:${key}` });
    const detail = { shard: key, accounts: members.length, pages: read.pages, truncated: read.truncated, backlog: read.backlog.length, backlogPages: read.backlogPages, dropped: read.dropped };
    const counts = new Map<string, { found: number; created: number }>();
    for (const m of members) {
      const handle = shardHandle(m)!.toLowerCase();
      const mine = read.tweets.filter((t) => t.user.screen_name.toLowerCase() === handle);
      const stored = await store(m.id, mine.map(tweetToCandidate).map((c) => rewriteUrl(c, m)).filter((c) => !noiseFiltered(c, m)), null, null);
      found += mine.length;
      created += stored.created;
      counts.set(m.id, { found: mine.length, created: stored.created });
    }
    // Only a fully stored search advances coverage. A failed write can replay every paid page;
    // material already committed is idempotent, and no member is left half-finished.
    await sql.begin(async tx => {
      for (const m of members) {
        const own = String(m.cursor!.lastTweetId);
        const cursor: Record<string, unknown> = { ...m.cursor, lastTweetId: read.lastId && BigInt(read.lastId) > BigInt(own) ? read.lastId : own, lastOkAt: new Date().toISOString() };
        if (read.backlog.length) cursor.xBacklog = read.backlog;
        else delete cursor.xBacklog;
        await tx`
          UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL,
            health = 'ok', cursor = ${tx.json(cursor as never)}, interval_minutes = ${minutes}, updated_at = now(),
            next_fetch_at = now() + make_interval(mins => ${minutes})
          WHERE id = ${m.id}`;
        const count = counts.get(m.id)!;
        await tx`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${count.found}, new_count = ${count.created},
                    detail = ${tx.json(detail as never)} WHERE id = ${runs.get(m.id)!}`;
      }
      for (const receiptId of read.receiptIds) await completeReceipt(tx, receiptId);
    });
    return { key, status: "ok", accounts: members.length, found, created };
  } catch (error) {
    if (shutdownSignal.signal.aborted) throw error;
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    const budget = error instanceof BudgetExceededError;
    for (const m of members) {
      await sql`
        UPDATE sources SET last_fetch_at = now(),
          fail_count = CASE WHEN ${budget} THEN fail_count ELSE fail_count + 1 END,
          last_error = ${message},
          health = CASE WHEN ${budget} THEN health WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
          next_fetch_at = now() + make_interval(mins => CASE WHEN ${budget} THEN 15 ELSE LEAST(${minutes} * (fail_count + 2), 360) END),
          updated_at = now()
        WHERE id = ${m.id}`;
      await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), error = ${message}, detail = ${sql.json({ shard: key, accounts: members.length })} WHERE id = ${runs.get(m.id)!}`;
    }
    return { key, status: "failed", accounts: members.length, found, created, error: message };
  }
}

/** X accounts read by shard: a plain query and a watermark (the first fetch of an account is its own). */
const sharded = () => sql`kind = 'x_search' AND config->>'query' ~* ${SHARDABLE_SQL} AND coalesce(config->>'searchType', 'Latest') = 'Latest' AND cursor->>'lastTweetId' IS NOT NULL`;

/** Every minute: a shard is read when any of its accounts is due, all of them at once. */
async function scheduleXShards(): Promise<number> {
  const rows = await sql<Array<Pick<SourceRow, "id" | "kind" | "config" | "cursor" | "participation_mode"> & { due: boolean }>>`
    SELECT id, kind, config, cursor, participation_mode, (next_fetch_at IS NULL OR next_fetch_at <= now()) AS due
    FROM sources WHERE enabled AND ${sharded()}`;
  const due = new Set(rows.filter((r) => r.due).map((r) => r.id));
  let enqueued = 0;
  for (const shard of planXShards(rows)) {
    if (!shard.sourceIds.some((id) => due.has(id))) continue;
    await enqueue(QUEUES.fetchXShard, { key: shard.key, sourceIds: shard.sourceIds }, { singletonKey: shard.key });
    await sql`UPDATE sources SET next_fetch_at = now() + interval '10 minutes' WHERE id IN ${sql(shard.sourceIds)}`;
    enqueued += 1;
  }
  return enqueued;
}

/** Every minute: enqueue due sources (enabled, not WeChat/external), oldest due first; X accounts by shard. */
export async function scheduleDueSources(limit = Number(process.env.FETCH_SCHEDULE_BATCH || 40)): Promise<{ enqueued: number; shards: number }> {
  await getBoss();
  const high=Number(process.env.COLLECTION_BACKLOG_HIGH || 2000);
  const low=Math.min(high,Number(process.env.COLLECTION_BACKLOG_LOW || 1000));
  const blocked=await sql.begin(async tx=>{
    await tx`INSERT INTO collection_flow_control(id) VALUES (1) ON CONFLICT DO NOTHING`;
    const [state]=await tx`SELECT blocked FROM collection_flow_control WHERE id=1 FOR UPDATE`;
    const [load]=await tx`SELECT (SELECT count(*) FROM collection_items WHERE completed_at IS NULL)+
      (SELECT count(*) FROM pgboss.job WHERE name IN ('content.extract-body','content.analyze') AND state IN ('created','retry','active')) AS pending`;
    const paused=state!.blocked ? Number(load!.pending)>low : Number(load!.pending)>=high;
    await tx`UPDATE collection_flow_control SET blocked=${paused},pending=${Number(load!.pending)},updated_at=now() WHERE id=1`;
    return paused;
  });
  if(blocked)return {enqueued:0,shards:0};
  const kinds: string[] = (process.env.COLLECT_KINDS || "rss,web_list,json_list,x_search").split(",");
  // Listings fetched through Jina Reader are paid; development can leave them out.
  const skipJina = process.env.COLLECT_SKIP_JINA === "true";
  const rows = await sql<{ id: string; config: Record<string,any> }[]>`
    WITH due AS (
      SELECT id,config,next_fetch_at,row_number() OVER (PARTITION BY
        lower(substring(coalesce(config->>'feedUrl',config->>'url',id) from '^(?:https?://)?([^/]+)'))
        ORDER BY next_fetch_at NULLS FIRST,id) AS domain_position
      FROM sources
      WHERE enabled AND kind IN ${sql(kinds)} AND (next_fetch_at IS NULL OR next_fetch_at <= now()) AND NOT (${sharded()})
        AND NOT EXISTS(SELECT 1 FROM collection_intakes i WHERE i.source_id=sources.id AND i.finished_at IS NULL)
        ${skipJina ? sql`AND config::text NOT LIKE '%r.jina.ai%'` : sql``}
    ) SELECT id,config FROM due WHERE domain_position<=2 ORDER BY domain_position,next_fetch_at NULLS FIRST,id LIMIT ${limit}`;
  for (const r of rows) {
    await enqueue(QUEUES.fetchSource, { sourceId: r.id }, { singletonKey: r.id, group: { id: collectionDomain(r.config.feedUrl ?? r.config.url) } });
    await sql`UPDATE sources SET next_fetch_at = now() + interval '10 minutes' WHERE id = ${r.id}`;
  }
  const shards = kinds.includes("x_search") ? await scheduleXShards() : 0;
  return { enqueued: rows.length, shards };
}

/**
 * Daily: adapt each source's interval to its recent output (active 15 min … quiet 120 min).
 * hot_signal sources are allowed to be slower.
 */
export async function adaptIntervals(): Promise<{ updated: number }> {
  const rows = await sql<Array<Pick<SourceRow, "id" | "participation_mode" | "kind" | "config" | "cursor"> & { paid_listing: boolean; per_day: number }>>`
    SELECT s.id, s.participation_mode, s.kind, s.config, s.cursor, coalesce(s.config->>'url', '') LIKE 'https://r.jina.ai/%' AS paid_listing,
      (SELECT count(*) FROM articles a WHERE a.source_id = s.id AND a.discovered_at > now() - interval '7 days' AND NOT a.backfill) / 7.0 AS per_day
    FROM sources s WHERE s.enabled AND s.kind IN ('rss', 'web_list', 'json_list', 'x_search')`;
  let updated = 0;
  for (const r of rows) {
    const perDay = Number(r.per_day);
    // Editorial sites and feeds are looked at hourly at least (they cost nothing);
    // editorial X and listings read through Jina stop at two hours (paid per call, within their budgets);
    // hot signals may wait longer.
    const max = r.participation_mode === "hot_signal" ? 180 : r.kind === "x_search" || r.paid_listing ? 120 : 60;
    // Listings read through Jina are not looked at more than hourly: busy ones would outrun its daily budget.
    const min = r.paid_listing ? 60 : 15;
    // X accounts read by shard follow the shard's pace, whatever their own volume.
    const target = shardHandle(r) ? shardMinutes(r.participation_mode) : perDay <= 0.15 ? max : Math.round(Math.min(max, Math.max(min, (24 * 60) / (perDay * 3))));
    const res = await sql`UPDATE sources SET interval_minutes = ${target} WHERE id = ${r.id} AND interval_minutes <> ${target}`;
    updated += res.count;
  }
  return { updated };
}
