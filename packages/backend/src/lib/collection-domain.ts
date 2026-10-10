/** Shared queue group for sources and article pages, including Jina's wrapped origin URL. */
export function collectionDomain(raw: string | null | undefined): string {
  try {
    let url = new URL(raw ?? "");
    if (url.hostname === "r.jina.ai") {
      const target = url.pathname.slice(1);
      if (/^https?:\/\//i.test(target)) url = new URL(target);
    }
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "unknown-domain";
  }
}
