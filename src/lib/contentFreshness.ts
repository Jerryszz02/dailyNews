export const defaultMaxPublishedContentAgeMinutes = 120;

export interface PublishedContentFreshness {
  publishable: boolean;
  newestPublishedAt: string | null;
  ageMinutes: number | null;
  maxAgeMinutes: number;
}

export function evaluatePublishedContentFreshness(
  items: Array<{ publishedAt?: string | null }>,
  referenceAt: Date,
  maxAgeMinutes = defaultMaxPublishedContentAgeMinutes,
): PublishedContentFreshness {
  const referenceTimestamp = referenceAt.getTime();
  const normalizedMaxAgeMinutes =
    Number.isFinite(maxAgeMinutes) && maxAgeMinutes > 0 ? maxAgeMinutes : defaultMaxPublishedContentAgeMinutes;
  if (!Number.isFinite(referenceTimestamp)) {
    return {
      publishable: false,
      newestPublishedAt: null,
      ageMinutes: null,
      maxAgeMinutes: normalizedMaxAgeMinutes,
    };
  }

  const publishedTimestamps = items
    .map((item) => Date.parse(item.publishedAt ?? ""))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp <= referenceTimestamp);
  if (publishedTimestamps.length === 0) {
    return {
      publishable: false,
      newestPublishedAt: null,
      ageMinutes: null,
      maxAgeMinutes: normalizedMaxAgeMinutes,
    };
  }

  const newestTimestamp = Math.max(...publishedTimestamps);
  const ageMinutes = (referenceTimestamp - newestTimestamp) / 60_000;
  return {
    publishable: ageMinutes <= normalizedMaxAgeMinutes,
    newestPublishedAt: new Date(newestTimestamp).toISOString(),
    ageMinutes,
    maxAgeMinutes: normalizedMaxAgeMinutes,
  };
}
