import type { NewsSource } from "../types";

export type SourceDefinition = Omit<
  NewsSource,
  "admission" | "publicationRole" | "signalRole" | "allowedHosts" | "reviewedAt" | "reviewNote"
>;

const sourceReviewDate = "2026-08-03";
const sharedProfileHosts = new Set(["x.com", "twitter.com"]);

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

function hostFromUrl(url: string): string | null {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

function secureSourceUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    if (parsed.port && parsed.port !== "443") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function defineApprovedSource(source: SourceDefinition): NewsSource {
  const readerUrls = source.sections.flatMap((section) => [section.url, ...(section.readerUrlAliases ?? [])]);
  const insecureSection = readerUrls.find((url) => !secureSourceUrl(url));
  if (insecureSection) {
    throw new Error(`Approved source ${source.source_id} must use credential-free HTTPS section URLs`);
  }
  const allowedHosts = Array.from(
    new Set(readerUrls.map(hostFromUrl).filter((host): host is string => Boolean(host))),
  );
  if (allowedHosts.length === 0) {
    throw new Error(`Approved source ${source.source_id} must declare at least one valid section URL`);
  }
  const allowedPathPrefixes = Array.from(new Set(readerUrls.flatMap((readerUrl) => {
    try {
      const url = new URL(readerUrl);
      const host = normalizeHost(url.hostname);
      const profile = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
      return sharedProfileHosts.has(host) && profile ? [`${host}/${profile}`] : [];
    } catch {
      return [];
    }
  })));

  return {
    ...source,
    admission: "approved",
    publicationRole: ["wire", "public", "official"].includes(source.mediaType) ? "lead" : "reporting",
    signalRole:
      source.mediaType === "official"
        ? "first_party"
        : source.mediaType === "social"
          ? "discussion"
          : source.mediaType === "technology" || source.mediaType === "business"
            ? "analysis"
            : "reporting",
    allowedHosts,
    ...(allowedPathPrefixes.length > 0 ? { allowedPathPrefixes } : {}),
    reviewedAt: sourceReviewDate,
    reviewNote: "Existing curated source approved during the completeness-first source admission migration.",
  };
}

export function isApprovedSource(source: NewsSource): boolean {
  return source.admission === "approved";
}

export function isCollectibleSource(source: NewsSource): boolean {
  return source.enabled && isApprovedSource(source);
}

export function isAllowedSourceUrl(source: NewsSource, url: string): boolean {
  if (source.admission !== "approved") return false;
  const candidateUrl = secureSourceUrl(url);
  if (!candidateUrl) return false;
  const candidateHost = normalizeHost(candidateUrl.hostname);
  const matchingAllowedHosts = source.allowedHosts
    .map(normalizeHost)
    .filter((allowedHost) => candidateHost === allowedHost || candidateHost.endsWith(`.${allowedHost}`));
  if (matchingAllowedHosts.length === 0) return false;
  const normalizedPathPrefixes = (source.allowedPathPrefixes ?? []).map((prefix) => prefix.toLowerCase());
  const scopedAllowedHost = matchingAllowedHosts.find((allowedHost) =>
    normalizedPathPrefixes.some((prefix) => prefix.startsWith(`${allowedHost}/`)),
  );
  if (!scopedAllowedHost) return true;
  const pathPrefixes = normalizedPathPrefixes.filter((prefix) => prefix.startsWith(`${scopedAllowedHost}/`));
  if (pathPrefixes.length === 0) return true;
  const candidatePath = `${scopedAllowedHost}/${candidateUrl.pathname.split("/").filter(Boolean).join("/")}`.toLowerCase();
  return pathPrefixes.some((prefix) => {
    const normalizedPrefix = prefix.replace(/\/$/, "");
    return candidatePath === normalizedPrefix || candidatePath.startsWith(`${normalizedPrefix}/`);
  });
}

export function validateSourceAdmission(sources: NewsSource[]): string[] {
  const issues: string[] = [];
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.source_id)) issues.push(`duplicate source_id: ${source.source_id}`);
    sourceIds.add(source.source_id);
    if (source.admission === "approved" && source.allowedHosts.length === 0) {
      issues.push(`approved source has no allowedHosts: ${source.source_id}`);
    }
    if (source.admission === "approved" && !source.signalRole) {
      issues.push(`approved source has no signalRole: ${source.source_id}`);
    }
    if (source.admission === "approved") {
      for (const section of source.sections) {
        for (const url of [section.url, ...(section.readerUrlAliases ?? [])]) {
          if (!isAllowedSourceUrl(source, url)) issues.push(`section URL is outside allowedHosts: ${source.source_id}:${url}`);
        }
      }
    }
  }
  return issues;
}
