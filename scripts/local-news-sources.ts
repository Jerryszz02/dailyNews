// Verify the preserved source inventory against live public pages. Opt-in application is local-only.
// node --env-file=.env scripts/local-news-sources.ts [--apply] [--pilot]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, REPO_ROOT } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { fetchRss } from "@aihot/backend/sources/rss";
import { fetchSitemap } from "@aihot/backend/sources/sitemap";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { allowed, fetchDetail, fetchWebList } from "@aihot/backend/sources/web-list";
import type { SourceRow } from "@aihot/backend/sources/types";
import { localSourceCandidate, verifiedReaderEvidence, type LocalSourceAdapter } from "./local-source-config.ts";

const apply = process.argv.includes("--apply");
const pilotOnly = process.argv.includes("--pilot");
const onlyIds = process.argv.find(arg => arg.startsWith("--ids="))?.slice(6).split(",");
const url = new URL(config.databaseUrl);
if (config.environmentName !== "local" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
  throw new Error("This source verification command requires an explicitly local environment/database");
}
const seeds = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")).sources as SourceRow[];
const pilot = JSON.parse(readFileSync(path.join(REPO_ROOT, "reference/trials/p5-2026-10-03-sources.json"), "utf8")).sources as LocalSourceAdapter[];
const overrides = new Map(pilot.map(s => [s.id, s]));
const currentAdapters = JSON.parse(readFileSync(path.join(REPO_ROOT, "reference/local/source-adapter-overrides.json"), "utf8")).sources as LocalSourceAdapter[];
for (const source of currentAdapters) overrides.set(source.id, source);
const sources = await sql<SourceRow[]>`SELECT * FROM sources ORDER BY id`;
const seedIds = new Set(seeds.map(s => s.id));
if (seeds.some(s => !sources.some(row => row.id === s.id))) throw new Error("Preserved source inventory is incomplete; seed it first");
type Result = { id: string; name: string; status: string; reason?: string; checkedAt: string; count?: number; readerUrl?: string; bodyChars?: number; summaryChars?: number; materialScope?: string; publishedAt?: string | null; kind?: SourceRow['kind']; config?: SourceRow["config"]; beforeConfig?: SourceRow['config']; beforeKind?: SourceRow['kind'] };
const results: Result[] = [];
const pending = sources.filter(s => seedIds.has(s.id));
async function verify(source: SourceRow): Promise<Result> {
  const base = { id: source.id, name: source.name, checkedAt: new Date().toISOString() };
  const dn = source.config.dailyNews;
  if (dn?.legacyEnabled !== true) return { ...base, status: "preserved_disabled", reason: dn?.disabledReason ?? "原配置禁用" };
  if (onlyIds && !onlyIds.includes(source.id)) return { ...base, status: "not_selected" };
  if (pilotOnly && !overrides.has(source.id)) return { ...base, status: "not_in_pilot" };
  if (source.kind === "x_search") return { ...base, status: "needs_credentials", reason: "保留原 X 账号；本轮未接入或购买 X 采集服务" };
  const adapter = overrides.get(source.id);
  const intendedKind = adapter?.kind ?? source.kind;
  if (intendedKind === "web_list" && (adapter?.configOverrides.dailyNews?.adapter ?? dn.adapter) !== "sitemap" && !(adapter?.configOverrides.itemSelector ?? source.config.itemSelector)) {
    return { ...base, status: "needs_adapter", reason: "原入口已保留；尚缺该网页的已验证列表选择器" };
  }
  try {
    const candidate = localSourceCandidate(source, adapter, base.checkedAt);
    const rows = candidate.kind === "rss" ? (await fetchRss(candidate, { force: true })).candidates
      : candidate.kind === "json_list" ? await fetchJsonList(candidate)
      : candidate.config.dailyNews.adapter === "sitemap" ? (await fetchSitemap(candidate)).candidates : await fetchWebList(candidate);
    const permitted = rows.filter(c => allowed(c.url, candidate) && c.title.trim().length >= 4);
    if (!permitted.length) return { ...base, status: "empty", reason: "没有匹配原来源边界的新闻", count: rows.length };
    let lastError = "没有可验证的正文链接";
    // A single inaccessible headline need not hide an otherwise readable source; record actual evidence.
    for (const item of permitted.slice(0, 3)) {
      try {
        const detail = await fetchDetail(item.url, candidate, { date: true, title: true, summary: !!candidate.config.detail?.summarySelector, body: true }, { strictHttp: true });
        const evidence = verifiedReaderEvidence(item, detail, { authoritativeDate: candidate.config.detail?.publishedAtAuthoritative === true });
        if (!evidence.publishedAt) throw new Error("缺少可信的来源发布时间，保留配置等待适配");
        if (!evidence.usable) throw new Error("正文与来源简介均不足，保留配置等待适配");
        return { ...base, status: "verified", count: permitted.length, readerUrl: item.url, ...evidence, kind: candidate.kind, config: candidate.config, beforeConfig: source.config, beforeKind: source.kind };
      } catch (error) { lastError = String(error instanceof Error ? error.message : error).slice(0, 250); }
    }
    return { ...base, status: "reader_failed", reason: lastError, count: permitted.length };
  } catch (error) {
    return { ...base, status: "listing_failed", reason: String(error instanceof Error ? error.message : error).slice(0, 250) };
  }
}
await Promise.all(Array.from({ length: 4 }, async () => {
  while (pending.length) {
    const result = await verify(pending.shift()!);
    results.push(result);
    if (!["needs_adapter", "needs_credentials", "preserved_disabled", "not_in_pilot", "not_selected"].includes(result.status)) console.log(JSON.stringify({ id: result.id, status: result.status, count: result.count, reason: result.reason }));
  }
}));
if (apply) {
  for (const result of results.filter(r => r.status === "verified")) {
    await sql.begin(async tx => {
      const [before] = await tx`SELECT enabled, kind, config FROM sources WHERE id=${result.id} FOR UPDATE`;
      if (!before || before.config.dailyNews?.legacyEnabled !== true || before.kind !== result.beforeKind || JSON.stringify(before.config) !== JSON.stringify(result.beforeConfig)) {
        result.status = 'config_changed'; result.reason = '验证期间配置发生变化，未覆盖；需要重新核验'; return;
      }
      await tx`UPDATE sources SET kind=${result.kind!}, config=${tx.json(result.config! as never)}, enabled=true, next_fetch_at=now(), updated_at=now() WHERE id=${result.id}`;
      await audit("local-operator", "source.local-verify", `source:${result.id}`, null, before,
        { enabled: true, kind: result.kind, config: result.config, readerUrl: result.readerUrl, materialScope: result.materialScope, checkedAt: result.checkedAt }, { db: tx });
    });
  }
}
const directory = path.join(config.dataDir, "local-quality");
mkdirSync(directory, { recursive: true });
const output = path.join(directory, `sources-${pilotOnly ? "pilot" : "all"}-${Date.now()}.json`);
const summary = results.reduce<Record<string, number>>((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {});
writeFileSync(output, JSON.stringify({ checkedAt: new Date().toISOString(), applied: apply, summary, results: results.sort((a, b) => a.id.localeCompare(b.id)) }, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ applied: apply, summary, output }));
await closeDb();
