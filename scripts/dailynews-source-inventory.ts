// Deterministic mapping of the frozen Daily News source baseline into disabled AIHOT seed rows.
// Run with: node scripts/dailynews-source-inventory.ts
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASELINE = path.join(ROOT, "reference/baselines/legacy-sources.json");
const SEED = path.join(ROOT, "industry/sources.json");
const DOC = path.join(ROOT, "docs/source-migration-inventory.md");
const BASELINE_COMMIT = "8519831714b0d6c8183336c81e8190dceddf7843";

interface LegacySection {
  sectionId?: string; label: string; url: string; feedUrl?: string; primaryCategory: string;
  categories: string[]; readerUrlAliases?: string[];
  searchTerms?: string[]; searchSources?: string[]; requireChinese?: boolean;
}
interface LegacySource {
  source_id: string; name: string; language: string; mediaType: string; credibility: number;
  mayHavePaywall: boolean; enabled: boolean; admission: string; publicationRole: string;
  signalRole: string; allowedHosts: string[]; allowedPathPrefixes?: string[];
  xUsername?: string; reviewedAt?: string; sections: LegacySection[];
}
interface Baseline { commit: string; sources: LegacySource[]; sections: LegacySection[] }

// The same organization on its own site and official X account gets one heat/evidence publisher.
// Personal accounts keep their own identity; no affiliation is inferred from a person's name.
const OFFICIAL_X_PUBLISHERS: Record<string, string> = {
  "x-openai": "openai", "x-anthropic": "anthropic", "x-deepmind": "google-deepmind", "x-googleai": "google-ai",
  "x-aiatmeta": "meta-ai", "x-microsoftai": "microsoft-ai", "x-nvidiaai": "nvidia-ai", "x-huggingface": "hugging-face",
  "x-deepseek_ai": "deepseek", "x-alibaba_qwen": "qwen", "x-zai_org": "z-ai", "x-nba": "nba", "x-fifacom": "fifa",
  "x-fiba": "fiba", "x-wta": "wta", "x-atptour": "atp", "x-worldathletics": "world-athletics",
  "x-olympics": "olympics", "x-f1": "f1", "x-ap": "ap", "x-bbcworld": "bbc", "x-channelnewsasia": "cna",
  "x-dwnews": "dw", "x-xhnews": "xinhua", "x-cctvnews": "cctv", "x-chinadaily": "china-daily",
  "x-federalreserve": "fed", "x-ecb": "ecb", "x-eu_commission": "eu-commission", "x-who": "who",
  "x-nasa": "nasa", "x-nature": "nature-news", "x-variety": "variety", "x-deadline": "deadline",
  "x-thr": "thr", "x-billboard": "billboard", "x-sciencenews": "science-news",
};
const PUBLISHER_ALIASES: Record<string, string> = {
  "bbc-sport": "bbc", "google-deepmind": "google", "google-ai": "google",
  "microsoft-ai": "microsoft", "nvidia-ai": "nvidia",
};
// These publishers have an explicit AIHOT tier in the fixed imported baseline. Credibility is
// retained separately for Daily News policy and never converted into an AIHOT tier.
const AIHOT_PUBLISHER_TIERS: Record<string, ["T1" | "T2", string]> = {
  openai: ["T1", "rss-openai-news"], google: ["T1", "rss-google-deepmind / rss-google-research"],
  "hugging-face": ["T1", "rss-hugging-face"], microsoft: ["T1", "rss-microsoft-research"],
  nvidia: ["T1", "rss-nvidia-blog"], "github-blog": ["T1", "rss-github-ai"],
  "the-verge": ["T2", "rss-the-verge-ai"], techcrunch: ["T2", "rss-techcrunch-ai"],
  "ars-technica": ["T2", "rss-ars-technica-ai"], "mit-tech-review": ["T2", "rss-mit-tech-review-ai"],
};
const PAYWALL_DISABLED = new Set(["reuters", "bloomberg", "ft", "wsj", "the-athletic-nba"]);

function adapter(source: LegacySource, section: LegacySection): "rss" | "sitemap" | "x_official" | "web_list" {
  if (source.xUsername) return "x_official";
  const entry = section.feedUrl ?? section.url;
  if (/sitemap(?:[-/]|\.|$)/i.test(new URL(entry).pathname)) return "sitemap";
  return section.feedUrl ? "rss" : "web_list";
}

function reason(source: LegacySource, mode: ReturnType<typeof adapter>): string {
  if (!source.enabled) return PAYWALL_DISABLED.has(source.source_id)
    ? "旧站禁用：原文访问或付费墙不可靠" : "旧站禁用：来源可验证性尚未确认";
  if (mode === "x_official") return "待官方 X API 凭据与有限试抓；不使用 SocialData";
  if (mode === "web_list") return "缺已验证的列表选择器；禁止通用链接扫描";
  if (mode === "sitemap") return "待 news sitemap 结构与原文链接实抓验证";
  return "待 feed 与原文链接的有限试抓验证";
}

export interface SeedRow {
  id: string; name: string; kind: "rss" | "web_list" | "x_search";
  config: Record<string, unknown>; tier: string; first_party: boolean;
  owner_entity_id: string | null;
  participation_mode: "editorial"; interval_minutes: number;
  site_fulltext: false; syndicate_fulltext: false; enabled: false;
}

export function makeInventory(baseline: Baseline): SeedRow[] {
  if (baseline.commit !== BASELINE_COMMIT) throw new Error(`unexpected baseline commit: ${baseline.commit}`);
  const sourceSections = baseline.sources.flatMap((source) => source.sections.map((section) => ({ sourceId: source.source_id, section })));
  if (sourceSections.length !== 187 || baseline.sections.length !== 187) throw new Error("frozen section coverage changed");
  const frozen = new Map<string, string>();
  sourceSections.forEach(({ sourceId, section }, i) => {
    const entry = baseline.sections[i]!;
    if (entry.label !== section.label || entry.url !== section.url || !/^[0-9a-f]{12}$/.test(entry.sectionId ?? ""))
      throw new Error(`frozen section mismatch at ${sourceId}/${section.label}/${section.url}`);
    const key = `${sourceId}\0${section.url}\0${section.label}`;
    if (frozen.has(key)) throw new Error(`duplicate frozen section: ${key}`);
    frozen.set(key, entry.sectionId!);
  });
  const rows: SeedRow[] = [];
  const ids = new Set<string>();
  for (const source of baseline.sources) {
    if (source.admission !== "approved") throw new Error(`source not approved: ${source.source_id}`);
    const labels = new Set<string>();
    for (const section of source.sections) {
      if (labels.has(section.label)) throw new Error(`ambiguous section label: ${source.source_id}/${section.label}`);
      labels.add(section.label);
      const frozenId = frozen.get(`${source.source_id}\0${section.url}\0${section.label}`);
      if (!frozenId) throw new Error(`unmapped section: ${source.source_id}/${section.label}`);
      const id = `dn-${source.source_id}-${frozenId}`;
      if (ids.has(id) || id.length > 80) throw new Error(`duplicate or long source id: ${id}`);
      ids.add(id);
      const mode = adapter(source, section);
      const rawPublisher = OFFICIAL_X_PUBLISHERS[source.source_id] ?? source.source_id;
      const publisher = PUBLISHER_ALIASES[rawPublisher] ?? rawPublisher;
      const publisherKey = `publisher:${publisher}`;
      const tierMatch = AIHOT_PUBLISHER_TIERS[publisher];
      const dailyNews = {
        legacySourceId: source.source_id,
        sectionId: frozenId,
        tierReason: tierMatch ? `AIHOT baseline publisher ${tierMatch[1]}` : "无对应 AIHOT 已确认来源；默认 T2，待逐来源复核",
        sectionLabel: section.label,
        sectionUrl: section.url,
        sourceCredibility: source.credibility,
        mediaType: source.mediaType,
        signalRole: source.signalRole,
        mayHavePaywall: source.mayHavePaywall,
        primaryCategoryHint: section.primaryCategory,
        publisherKey,
        language: source.language,
        allowedHosts: source.allowedHosts,
        allowedPathPrefixes: source.allowedPathPrefixes ?? [],
        readerUrlAliases: section.readerUrlAliases ?? [],
        legacyEnabled: source.enabled,
        disabledReason: reason(source, mode),
        migrationStatus: !source.enabled ? "legacy_disabled" : mode === "web_list" ? "needs_selector" : mode === "x_official" ? "needs_x_credentials" : "configured_unverified",
        adapter: mode,
        // The baseline's terms stay visible for a later bounded fallback configuration. No search runs from seed data.
        searchTerms: section.searchTerms ?? [],
        searchSources: section.searchSources ?? [],
        reviewedAt: source.reviewedAt ?? null,
      };
      const config: Record<string, unknown> = { dailyNews, _aihot: { initialBackfillLimit: 10, initialBackfillMonths: 1 } };
      if (mode === "rss") config.feedUrl = section.feedUrl;
      else if (mode === "x_official") config.xUsername = source.xUsername;
      else config.url = section.feedUrl ?? section.url;
      rows.push({
        id, name: `${source.name} · ${section.label}`, kind: mode === "rss" ? "rss" : mode === "x_official" ? "x_search" : "web_list",
        config, tier: tierMatch?.[0] ?? "T2", first_party: source.signalRole === "first_party",
        owner_entity_id: source.signalRole === "first_party" ? publisherKey.slice("publisher:".length) : null,
        participation_mode: "editorial", interval_minutes: 60, site_fulltext: false, syndicate_fulltext: false, enabled: false,
      });
    }
  }
  return rows;
}

const cell = (v: unknown) => String(v ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
export function renderInventoryMarkdown(rows: SeedRow[]): string {
  const kinds = Object.groupBy(rows, (r) => String((r.config.dailyNews as { adapter: string }).adapter));
  const lines = [
    "# Daily News 信源迁移清单",
    "",
    `固定旧基准：\`${BASELINE_COMMIT}\`；共 ${new Set(rows.map((r) => (r.config.dailyNews as { legacySourceId: string }).legacySourceId)).size} 个旧来源、${rows.length} 个栏目。`,
    `采集方式：RSS/Atom ${kinds.rss?.length ?? 0}、news sitemap ${kinds.sitemap?.length ?? 0}、待配置网页选择器 ${kinds.web_list?.length ?? 0}、官方 X API ${kinds.x_official?.length ?? 0}。`,
    "",
    "所有新种子默认停用，表中“旧站启用”只记录旧配置；不代表新系统已试抓或可自动启用。`primaryCategoryHint` 只作分类提示。RSS 与 sitemap 的 reader URL、日期及正文许可尚待实抓。网页栏目必须先验证选择器。JSON/API 解析器可复用，但本次冻结基准没有可直接映射的 JSON 栏目。X 仅保留官方 API 账号与 cursor 方案；缺凭据时无请求。Firecrawl fallback 沿用旧站 `firecrawl` SDK 4.28.3 的空 key 搜索方式，仅在来源与环境均显式启用、且数据库预算解除零限额后才可调用；当前未实测 keyless 服务可用性。",
    "",
    "同一旧来源的栏目共享 `publisherKey`；已明确对应的官网、分栏目（如 BBC 体育）和官方 X 账号也共享该键。数据库种子插入时把它写入 `signal_group_id`，官方 first-party 来源另用同一标准名写入 `owner_entity_id`，避免栏目拆分虚增独立热度来源。AI tier 只继承 AIHOT 固定基准中已确认的同一发布者；其他默认 T2 待逐来源复核，绝不由旧 `sourceCredibility` 换算。非 AI 证据仍通过 `legacySourceId` 与旧 hostname 计算。种子只插入不存在的 ID，改动 JSON 不会自动覆盖已有数据库配置。",
    "",
    "| 新 ID | 旧 ID / 栏目 ID | 来源与栏目 | 入口 / 读者链接 | 允许主机 / 路径 | 发布者键 | 主类提示 | 语言 | 角色 / AI tier 与依据 | 旧站启用 / 付费墙 | 读者可访问 / 全文许可 | 迁移方式 / 状态 | 试抓 / 最后验证 | 停用原因 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const d = row.config.dailyNews as Record<string, unknown>;
    const entry = row.config.feedUrl ?? row.config.url ?? `https://x.com/${row.config.xUsername}`;
    const aliases = d.readerUrlAliases as string[];
    const hosts = d.allowedHosts as string[];
    const paths = d.allowedPathPrefixes as string[];
    lines.push(`| ${cell(row.id)} | ${cell(`${d.legacySourceId} / ${d.sectionId}`)} | ${cell(row.name)} | ${cell(entry)}${aliases.length ? `<br>别名：${cell(aliases.join("、"))}` : ""} | ${cell(hosts.join("、"))}${paths.length ? `<br>${cell(paths.join("、"))}` : ""} | ${cell(d.publisherKey)} | ${cell(d.primaryCategoryHint)} | ${cell(d.language)} | ${cell(`${d.signalRole} / ${row.tier}`)}<br>${cell(d.tierReason)} | ${d.legacyEnabled ? "是" : "否"} / ${d.mayHavePaywall ? "是" : "否"} | 待验证 / 仅标题摘要与原文链接 | ${cell(`${d.adapter} / ${d.migrationStatus}`)} | 未执行 / 未验证 | ${cell(d.disabledReason)} |`);
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
  const rows = makeInventory(baseline);
  if (baseline.sources.length !== 169 || rows.length !== 187) throw new Error(`baseline coverage changed: ${baseline.sources.length}/${rows.length}`);
  writeFileSync(SEED, `${JSON.stringify({ $comment: "P3 frozen baseline mapping; all sources remain disabled until individually verified.", baselineCommit: BASELINE_COMMIT, sources: rows }, null, 2)}\n`);
  writeFileSync(DOC, renderInventoryMarkdown(rows));
  console.log(`mapped ${baseline.sources.length} sources / ${rows.length} sections; all disabled`);
}
