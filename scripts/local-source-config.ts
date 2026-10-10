import { assertSupportedConfig } from '@aihot/backend/sources/config-keys';
import type { SourceRow } from '@aihot/backend/sources/types';

export interface LocalSourceAdapter {
  id: string;
  kind?: SourceRow['kind'];
  configOverrides: SourceRow['config'];
}

const PUBLIC_KINDS = new Set(['rss', 'web_list', 'json_list']);
const COMMON_KEYS = new Set(['_aihot', 'dailyNews', 'allowUrlPrefixes', 'denyUrlPrefixes', 'ingestNoiseFilter',
  'itemUrlPrefixRewrite', 'sortByPublishedAt', 'detail', 'fetchPublicContent']);

/** Local transport repairs keep the source's admission, identity, scope and import policy. */
export function localSourceCandidate(source: SourceRow, adapter: LocalSourceAdapter | undefined, checkedAt: string): SourceRow {
  const kind = adapter?.kind ?? source.kind;
  if (!PUBLIC_KINDS.has(source.kind) || !PUBLIC_KINDS.has(kind)) throw new Error('Only existing public source transports can be adapted');
  if (adapter && adapter.id !== source.id) throw new Error('Source adapter identity mismatch');
  const patch = adapter?.configOverrides ?? {};
  const base = kind === source.kind ? source.config : Object.fromEntries(Object.entries(source.config).filter(([key]) => COMMON_KEYS.has(key)));
  const candidate: SourceRow = { ...source, kind, cursor: null, config: {
    ...base, ...patch,
    _aihot: source.config._aihot,
    detail: { maxFetches: 10, ...(source.config.detail ?? {}), ...(patch.detail ?? {}) },
    dailyNews: {
      ...source.config.dailyNews,
      adapter: patch.dailyNews?.adapter ?? (kind === source.kind ? source.config.dailyNews.adapter : kind),
      migrationStatus: 'verified', disabledReason: null, reviewedAt: checkedAt,
    },
  } };
  delete candidate.config.dailyNews.verifiedAt;
  assertSupportedConfig(kind, candidate.config);
  return candidate;
}

export function verifiedReaderEvidence(item: { excerpt?: string | null; publishedAt?: Date | null },
  detail: { body: { text: string } | null; summary: string | null; publishedAt: Date | null }) {
  const summary = detail.summary || item.excerpt || null;
  const publishedAt = detail.publishedAt ?? item.publishedAt ?? null;
  return {
    usable: !!detail.body || (summary?.trim().length ?? 0) >= 50,
    materialScope: detail.body ? 'extracted_body' : summary ? 'source_summary' : 'missing',
    bodyChars: detail.body?.text.length ?? 0,
    summaryChars: summary?.trim().length ?? 0,
    publishedAt: publishedAt?.toISOString() ?? null,
  };
}
