/** Frozen text normalization from Daily News 8519831714b0d6c8183336c81e8190dceddf7843. */
export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^\p{Script=Han}\p{Letter}\p{Number}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export function hostnameFromUrl(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}
