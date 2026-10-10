import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  CATEGORIES, CATEGORY_BY_ITEM_TYPE, CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, IDENTITY_CONTEXT_ALIASES,
  IDENTITY_LEXICON, ITEM_TYPES, PRIMARY_CATEGORY_TAG, PUBLISHER_DOMAINS, TAG_SYNONYMS, TOPIC_TAGS,
} from "@aihot/industry/taxonomy";
import { SELECTION } from "@aihot/industry/selection";
import { CATEGORY_KEYS, isCategoryKey } from "@aihot/contracts/taxonomy";
import { REPO_ROOT } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { MODELS } from "../providers/llm.ts";
import { CAPABILITIES, type CapabilityKey } from "./models.ts";
import { loadAnalyzeInput, type AnalyzeInputArticle } from "./input.ts";
import { promptText, promptVersion } from "./prompts.ts";
import { CATEGORY_GUIDE } from "./vocabulary.ts";

export const CLASSIFICATION_VERSION = "dailynews-ten-primary-v1";
export const AI_POLICY_VERSION = "aihot-3343fe2b20db-v1";
const RULE_DIR = path.join(REPO_ROOT, "packages/backend/src/dailynews");
function ruleSources(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(dir, entry.name);
    return entry.isDirectory() ? ruleSources(absolute, relative)
      : entry.isFile() && entry.name.endsWith(".ts") ? [`${relative}\n${readFileSync(absolute, "utf8")}`] : [];
  });
}
const RULES_VERSION = sha256([
  readFileSync(path.join(REPO_ROOT, "src/lib/curation.ts"), "utf8"),
  ...ruleSources(RULE_DIR),
].join("\n"));
export const NON_AI_POLICY_VERSION = `dailynews-8519831714b0-${RULES_VERSION.slice(0, 12)}`;
export const MAX_CLASSIFICATION_RETRIES = 2;

export type AnalysisPolicyId = "aihot-ai-article" | "dailynews-non-ai-article" | "classification-pending";
export const policyIdForCategory = (category: string | null): AnalysisPolicyId =>
  category === "ai" ? "aihot-ai-article" : category && isCategoryKey(category) ? "dailynews-non-ai-article" : "classification-pending";
export const policyVersionForCategory = (category: string | null): string =>
  category === "ai" ? AI_POLICY_VERSION : category ? NON_AI_POLICY_VERSION : CLASSIFICATION_VERSION;

const ZH_COUNT = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
export const STRUCTURE_SYSTEM = promptText("structure", {
  categoryCount: ZH_COUNT[CATEGORIES.length] ?? String(CATEGORIES.length),
  categoryGuide: CATEGORY_GUIDE,
  categoryTags: CATEGORY_TAGS.join("、"), topicTags: TOPIC_TAGS.join("、"), entityTags: ENTITY_TAGS.join("、"),
  entities: Object.entries(ENTITIES).map(([id, e]) => `${id}（${e.aliases.slice(0, 3).join("/")}）`).join("，"),
});

const taxonomy = {
  CATEGORIES, CATEGORY_KEYS, ITEM_TYPES, CATEGORY_TAGS, TOPIC_TAGS, ENTITY_TAGS, TAG_SYNONYMS,
  CATEGORY_BY_ITEM_TYPE, PRIMARY_CATEGORY_TAG, ENTITIES,
  IDENTITY_LEXICON: IDENTITY_LEXICON.map((e) => ({ id: e.id, name: e.name, patterns: e.patterns.map(String) })),
  IDENTITY_CONTEXT_ALIASES: IDENTITY_CONTEXT_ALIASES.map((e) => ({ entityId: e.entityId, pattern: String(e.pattern) })),
  PUBLISHER_DOMAINS, SELECTION,
};
const PROMPTS_VERSION = promptVersion(
  "structure", "prefilter", "selection-score", "understand", "content-understanding",
  "summarize-article", "summarize-article-empty", "summarize-short-post", "summarize-short-post-quoted",
  "summarize-long-post", "summarize-long-post-quoted", "identity-context", "dailynews-non-ai-copy",
);
export const CLASSIFICATION_CONFIG_VERSION = sha256(stableJson({ classification: CLASSIFICATION_VERSION, taxonomy, structure: STRUCTURE_SYSTEM }));

const ANALYSIS_CAPABILITIES = ["structure", "prefilter", "score", "understand", "summarize"] as const satisfies readonly CapabilityKey[];
export type ActualModel = { key: string; service: string; model: string; baseUrl: string; extra: Record<string, unknown> | null };
export type AnalysisModels = Record<(typeof ANALYSIS_CAPABILITIES)[number], ActualModel>;

function publicBaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return ""; }
}

/** Read settings at commit time; the one-minute modelFor cache is unsuitable for validity checks. */
export async function currentAnalysisModels(db: Db = sql): Promise<AnalysisModels> {
  const rows = await db<{ key: string; value: { model?: string } }[]>`SELECT key, value FROM settings WHERE key LIKE 'models.%'`;
  const overrides = new Map(rows.map((r) => [r.key.slice("models.".length), r.value?.model]));
  return Object.fromEntries(ANALYSIS_CAPABILITIES.map((key) => {
    const cap = CAPABILITIES[key];
    const chosen = overrides.get(key) ?? process.env[cap.env] ?? cap.default;
    const spec = MODELS[chosen] ?? MODELS[cap.default]!;
    return [key, {
      key: spec.key, service: spec.service, model: spec.model,
      baseUrl: publicBaseUrl(process.env[spec.baseUrlEnv] ?? ""), extra: spec.extra ?? null,
    }];
  })) as AnalysisModels;
}

export function analysisSignature(input: AnalyzeInputArticle, models: AnalysisModels): string {
  return sha256(stableJson({
    revision: input.revision,
    material: [input.title, input.url, input.author, input.publishedAt?.toISOString(), input.bodyText, input.excerpt, input.xPost, input.media, input.translationZh],
    source: input.source,
    manualCategory: input.manualCategory ?? null,
    editorialCategory: input.editorialCategory ?? null,
    overrideVersion: input.overrideVersion ?? 0,
    taxonomy: CLASSIFICATION_CONFIG_VERSION,
    prompts: PROMPTS_VERSION,
    renderedStructure: STRUCTURE_SYSTEM,
    aiPolicy: AI_POLICY_VERSION,
    nonAiPolicy: NON_AI_POLICY_VERSION,
    nonAiRules: RULES_VERSION,
    models,
    // Do not alter historical uncalibrated signatures when an experiment is activated.
    ...(input.calibrationPolicy ? { calibration: input.calibrationPolicy.id } : {}),
  }));
}

/** Same transaction can compare this with analyses.input_signature before using a result. */
export async function currentAnalysisSignature(articleId: string, db: Db = sql): Promise<string | null> {
  const input = await loadAnalyzeInput(articleId, db);
  return input ? analysisSignature(input, await currentAnalysisModels(db)) : null;
}
