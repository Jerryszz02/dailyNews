const stopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "into",
  "over",
  "news",
  "says",
  "after",
  "about",
  "最新",
  "新闻",
  "报道",
  "发布",
  "今日",
  "持续",
]);

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .flatMap((token) => {
      if (/[\u4e00-\u9fff]/.test(token)) {
        return token.length > 2 ? [token, ...chunkChinese(token)] : [token];
      }
      return [token];
    })
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

function chunkChinese(value: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    chunks.push(value.slice(index, index + 2));
  }
  return chunks;
}

export function textInformationLength(value: string): number {
  const compact = value.replace(/\s+/g, "");
  const hanCount = (compact.match(/[\u3400-\u9fff]/g) ?? []).length;
  return compact.length + hanCount;
}

export function isInformativeText(value: string): boolean {
  return textInformationLength(value.trim()) >= 60;
}

export function tokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

export function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
