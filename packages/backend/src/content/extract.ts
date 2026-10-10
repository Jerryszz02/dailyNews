// Article body extraction: readable text from the article page, or "unconfirmed" — never a wrong body.
// Jina Reader is the budgeted fallback for pages that only render in a browser.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { jinaRead } from "../providers/jina.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { getArticle } from "../providers/socialdata.ts";
import { onlyXArticleLink, xArticleText } from "../sources/x.ts";
import { sanitizeBody, trimTrailingChrome } from "./sanitize.ts";
import { contentHash, invalidateRevisedMaterialTx } from "./materials.ts";
import { lockEditorialProjection } from "../publication/reprocess.ts";
import { markdownBody } from "./markdown.ts";

export interface ExtractedBody {
  html: string;
  text: string;
  images: Array<{ kind: "image"; url: string; width: number | null; height: number | null }>;
  via: "readability" | "jina";
}

const MIN_BODY_CHARS = 200;

/** Video landing pages are not transcripts: Readability often selects recommended clips. */
export function videoTranscript(html: string, url: string): { video: boolean; transcript: string | null } {
  const { document } = parseHTML(html);
  const objects: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      objects.push(row);
      Object.values(row).forEach(visit);
    }
  };
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(script.textContent ?? "")); } catch { /* malformed metadata */ }
  }
  const videos = objects.filter(row => [row["@type"]].flat().includes("VideoObject"));
  const articlePage = objects.some(row => [row["@type"]].flat().some(type => /^(?:NewsArticle|Article|BlogPosting)$/i.test(String(type))));
  const video = /\/(?:videos?|video)\//i.test(new URL(url).pathname) ||
    /video/i.test(document.querySelector('meta[property="og:type"]')?.getAttribute("content") ?? "") || (videos.length > 0 && !articlePage);
  // A related clip's transcript must never stand in for this page's clip.
  const normalized = (value: unknown) => {
    try { const u = new URL(String(value), url); return `${u.origin}${u.pathname.replace(/\/$/, "")}`; } catch { return ""; }
  };
  const own = videos.find(row => [row.url, row.mainEntityOfPage, row["@id"]].some(value =>
    normalized(value && typeof value === "object" ? (value as Record<string, unknown>)["@id"] : value) === normalized(url)));
  const transcript = typeof own?.transcript === "string" ? stripTags(sanitizeBody(own.transcript, url)).trim() : null;
  return { video, transcript: transcript && transcript.length >= MIN_BODY_CHARS ? transcript : null };
}

// The backend has no browser DOM globals; these are the parsed HTML operations used below.
type StaticElement = {
  tagName: string; textContent: string | null; children: ArrayLike<StaticElement>; parentElement: StaticElement | null;
  getAttribute(name: string): string | null; removeAttribute(name: string): void;
  querySelector(selector: string): StaticElement | null; querySelectorAll(selector: string): ArrayLike<StaticElement>;
  closest(selector: string): StaticElement | null; replaceWith(node: StaticElement): void; remove(): void;
};

/** Yahoo's public React stream contains the article body as HTML, waiting for one $RC insertion.
 * Restore only that exact static association; never evaluate the script or expose arbitrary hidden nodes.
 */
function restoreYahooArticleStream(document: ReturnType<typeof parseHTML>["document"], url: string): boolean {
  const page = new URL(url);
  if (page.protocol !== "https:" || page.hostname !== "sports.yahoo.com" || !/^\/nba\/article\/[^/]+\.html$/.test(page.pathname)) return true;
  const bodies = Array.from(document.querySelectorAll('div[hidden][id^="S:"] > .content-body')) as StaticElement[];
  if (!bodies.length) return true;
  if (bodies.length !== 1) return false;
  const identity = (value: unknown): string => {
    try { const u = new URL(String(value), url); return `${u.origin}${u.pathname}`; } catch { return ""; }
  };
  if (identity(document.querySelector('link[rel="canonical"]')?.getAttribute("href")) !== identity(url)) return false;
  const articles = (Array.from(document.querySelectorAll('article.story-container[id^="article-"]')) as StaticElement[]).filter(article =>
    (Array.from(article.querySelectorAll('script[type="application/ld+json"]')) as StaticElement[]).some(script => {
      try {
        const row = JSON.parse(script.textContent ?? "") as Record<string, unknown>;
        const own = row.mainEntityOfPage && typeof row.mainEntityOfPage === "object" ? (row.mainEntityOfPage as Record<string, unknown>)["@id"] : row.mainEntityOfPage;
        return row["@type"] === "NewsArticle" && identity(own) === identity(url) && ![false, "false"].includes(row.isAccessibleForFree as boolean | string);
      } catch { return false; }
    }));
  if (articles.length !== 1) return false;
  const holder = bodies[0]!.parentElement!;
  const streamId = holder.getAttribute("id") ?? "";
  if (!/^S:\d+$/.test(streamId) || holder.children.length !== 1 || document.querySelectorAll(`[id="${streamId}"]`).length !== 1) return false;
  const pairs: Array<{ boundary: string; stream: string }> = [];
  for (const script of document.querySelectorAll("script")) {
    const match = /^\s*\$RC\("(B:\d+)","(S:\d+)"\)\s*;?\s*$/.exec(script.textContent ?? "");
    if (match) pairs.push({ boundary: match[1]!, stream: match[2]! });
  }
  const matches = pairs.filter(pair => pair.stream === streamId);
  if (matches.length !== 1 || pairs.filter(pair => pair.boundary === matches[0]!.boundary).length !== 1) return false;
  const placeholders = Array.from(document.querySelectorAll(`[id="${matches[0]!.boundary}"]`)) as StaticElement[];
  if (placeholders.length !== 1 || placeholders[0]!.tagName !== "TEMPLATE" || placeholders[0]!.closest("article") !== articles[0]) return false;
  placeholders[0]!.replaceWith(bodies[0]!);
  holder.remove();
  return true;
}

/** This public Red Star template hides its article only while images load. The observed
 * base-hongxing.js always shows .wrapper after 500 ms; no scripts are executed here.
 */
function restoreRedStarArticle(document: ReturnType<typeof parseHTML>["document"], url: string): boolean {
  const page = new URL(url);
  if (page.protocol !== "https:" || page.hostname !== "static.cdsb.com" || !/^\/micropub\/Articles\/20\d{4}\/[a-f0-9]{32}\.html$/.test(page.pathname)) return true;
  const wrappers = Array.from(document.querySelectorAll('div.wrapper[style]')) as StaticElement[];
  const hidden = wrappers.filter(node => /display\s*:\s*none/i.test(node.getAttribute("style") ?? ""));
  if (!hidden.length) return true;
  if (hidden.length !== 1 || wrappers.length !== 1 || !/^\s*display\s*:\s*none\s*;?\s*$/i.test(hidden[0]!.getAttribute("style") ?? "")) return false;
  const bodies = Array.from(document.querySelectorAll('div.wrapper > section.cd-article > article.cd-article_content')) as StaticElement[];
  if (bodies.length !== 1 || document.querySelectorAll('article.cd-article_content').length !== 1 || bodies[0]!.closest('div.wrapper') !== hidden[0]) return false;
  const section = bodies[0]!.parentElement!;
  const title = section.querySelector('h1.title')?.textContent?.trim();
  const date = section.querySelector('#article-time')?.textContent?.trim() ?? "";
  if (!title || title !== document.querySelector('title')?.textContent?.trim() || !/^20\d{2}-\d{2}-\d{2} \d{2}:\d{2}$/.test(date) || !section.querySelector('.subtitle .source')?.textContent?.trim()) return false;
  const loadingScript = (Array.from(document.querySelectorAll('script[src]')) as StaticElement[]).some(script => {
    try { const u = new URL(script.getAttribute('src') ?? '', url); return u.protocol === 'https:' && u.hostname === 'staticfilecdn.cdsb.com' && u.pathname === '/staticfile/js/base-hongxing.js'; } catch { return false; }
  });
  if (!loadingScript) return false;
  hidden[0]!.removeAttribute('style');
  return true;
}

export function readable(html: string, url: string): ExtractedBody | null {
  const video = videoTranscript(html, url);
  if (video.video) {
    if (!video.transcript) return null;
    const clean = sanitizeBody(`<p>${video.transcript.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`, url);
    return { html: clean, text: video.transcript, images: [], via: "readability" };
  }
  const { document } = parseHTML(html);
  if (!restoreYahooArticleStream(document, url) || !restoreRedStarArticle(document, url)) return null;
  for (const node of document.querySelectorAll('aside, nav, footer, [role="navigation"], [class*="related"], [class*="recommend"]')) node.remove();
  for (const node of document.querySelectorAll('[class*="sidebar"]')) {
    // These observed layout classes describe the article beside a sidebar, or its absence.
    // Removing their ancestor would remove the entire story (including body.no-sidebar).
    const classes: string[] = String(node.getAttribute("class") ?? "").split(/\s+/);
    if (["BODY", "HTML", "MAIN"].includes(node.tagName) || classes.some(name =>
      /^(?:no-sidebars?|article-with-sidebar|t-content__(?:with|beside)-sidebar)$/.test(name))) continue;
    node.remove();
  }
  try {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
  } catch {
    // no head
  }
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: MIN_BODY_CHARS, keepClasses: false }).parse();
  if (!article?.content) return null;
  const clean = trimTrailingChrome(sanitizeBody(article.content, url));
  const text = stripTags(clean);
  if (text.length < MIN_BODY_CHARS) return null;
  const images: ExtractedBody["images"] = [];
  for (const m of clean.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) {
    const w = /\bwidth="(\d+)"/.exec(m[0]);
    const h = /\bheight="(\d+)"/.exec(m[0]);
    images.push({ kind: "image", url: m[1]!.replace(/&amp;/g, "&"), width: w ? Number(w[1]) : null, height: h ? Number(h[1]) : null });
    if (images.length >= 12) break;
  }
  return { html: clean, text, images, via: "readability" };
}

export async function extractFromUrl(url: string, opts: { allowJina: boolean; subject: string }): Promise<ExtractedBody | null> {
  try {
    const res = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 200 && /html/.test(type)) {
      const html = res.text();
      // Jina would flatten the same recommendations; a transcript-less video stays unconfirmed.
      if (videoTranscript(html, res.url).video) return readable(html, res.url);
      const got = readable(html, res.url);
      if (got) return got;
    }
  } catch {
    // fall through to Jina
  }
  if (!opts.allowJina || /\/(?:videos?|video)\//i.test(new URL(url).pathname)) return null;
  try {
    const page = await jinaRead(url, { purpose: "body_fallback", subject: opts.subject });
    const html = markdownBody(page.markdown, url);
    const text = stripTags(html);
    if (text.length < MIN_BODY_CHARS) return null;
    return { html, text, images: [], via: "jina" };
  } catch (error) {
    if (error instanceof BudgetExceededError) return null;
    throw error;
  }
}

/** Pages extraction can fetch: ordinary web pages (X posts and WeChat articles arrive whole or not at all). */
export function pageFetchable(url: string, sourceKind: string): boolean {
  if (sourceKind === "x_search" || sourceKind === "mp_account") return false;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !/(^|\.)(x\.com|twitter\.com|mp\.weixin\.qq\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Fetches and stores the body of one article. Unconfirmed bodies are recorded as such. */
export async function extractArticleBody(articleId: string, allowJina = process.env.JINA_BODY_FALLBACK !== "false"): Promise<"ok" | "unconfirmed" | "skipped"> {
  const [a] = await sql<{ id: string; url: string; body_status: string; revision: number; x_post: { tweetId?: string } | null }[]>`
    SELECT id, url, body_status, revision, x_post FROM articles WHERE id = ${articleId}`;
  if (!a || a.body_status === "ok") return "skipped";
  if (a.x_post?.tweetId) return extractXArticle(a.id, a.x_post.tweetId, a.revision);
  const got = await extractFromUrl(a.url, { allowJina, subject: `article:${a.id}` });
  if (!got) {
    return markUnconfirmed(articleId, a.revision);
  }
  // The body is new content: a new revision, so an analysis of the body-less input counts as stale.
  return sql.begin(async (tx) => {
    await lockEditorialProjection(tx);
    const [row] = await tx<{ title: string; excerpt: string | null; content_hash: string | null }[]>`
      SELECT title, excerpt, content_hash FROM articles
      WHERE id = ${articleId} AND revision = ${a.revision} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) return "skipped";
    const hash = contentHash({ title: row.title, bodyText: got.text, excerpt: row.excerpt });
    if (hash === row.content_hash) {
      await tx`UPDATE articles SET body_status = 'ok', updated_at = now() WHERE id = ${articleId}`;
      return "ok";
    }
    const [r] = await tx<{ revision: number }[]>`
      UPDATE articles SET body_html = ${got.html}, body_text = ${got.text}, body_status = 'ok',
        media = CASE WHEN jsonb_array_length(media) = 0 THEN ${tx.json(got.images as never)}::jsonb ELSE media END,
        revision = revision + 1, content_hash = ${hash}, processing_state = 'new', updated_at = now()
      WHERE id = ${articleId} RETURNING revision`;
    await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${articleId}, ${r!.revision}, ${hash}, ${row.title}, ${got.text})`;
    await invalidateRevisedMaterialTx(tx, articleId);
    return "ok";
  });
}

async function markUnconfirmed(articleId: string, revision: number): Promise<"unconfirmed" | "skipped"> {
  const rows = await sql`UPDATE articles SET body_status = 'unconfirmed', updated_at = now()
    WHERE id = ${articleId} AND revision = ${revision} AND body_status <> 'ok' RETURNING id`;
  return rows.length ? "unconfirmed" : "skipped";
}

/**
 * The X Article a post published (SocialData, paid, by the post's own id). The article joins the
 * post's body as a new revision; a post that is only the article's link takes the article's title.
 * No article (the link points at someone else's, or X has none) leaves the post "unconfirmed", and
 * the judging steps are told the article was not fetched.
 */
async function extractXArticle(articleId: string, tweetId: string, revision: number): Promise<"ok" | "unconfirmed" | "skipped"> {
  const found = await getArticle(tweetId, { purpose: "x_article", subject: `article:${articleId}` });
  const got = found ? xArticleText(found) : null;
  if (!got) {
    return markUnconfirmed(articleId, revision);
  }
  return sql.begin(async (tx) => {
    await lockEditorialProjection(tx);
    const [row] = await tx<{ title: string; excerpt: string | null; body_text: string | null; x_post: { text?: string } | null; x_article: { title?: string | null; text?: string } | null }[]>`
      SELECT title, excerpt, body_text, x_post, x_article FROM articles
      WHERE id = ${articleId} AND revision = ${revision} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) return "skipped";
    const block = (a: { title?: string | null; text?: string } | null) => (a ? [a.title ? `# ${a.title}` : "", a.text ?? ""].filter(Boolean).join("\n\n") : "");
    // The post's own text, without an article appended by an earlier extraction (an admin re-run
    // extracts again from the post; appending once more would repeat the article).
    const previous = block(row.x_article);
    let base = row.body_text ?? "";
    if (previous && base.endsWith(previous)) base = base.slice(0, -previous.length).replace(/\s+$/, "");
    const title = got.title && onlyXArticleLink(row.x_post?.text) ? got.title : row.title;
    const bodyText = [base, block(got)].filter(Boolean).join("\n\n");
    if (bodyText === row.body_text && title === row.title) {
      // The same article again: nothing new, no new revision.
      await tx`UPDATE articles SET body_status = 'ok', x_article = ${tx.json(got as never)}, updated_at = now() WHERE id = ${articleId}`;
      return "ok";
    }
    const hash = contentHash({ title, bodyText, excerpt: row.excerpt });
    const [r] = await tx<{ revision: number }[]>`
      UPDATE articles SET title = ${title}, body_text = ${bodyText}, x_article = ${tx.json(got as never)}, body_status = 'ok',
        revision = revision + 1, content_hash = ${hash}, processing_state = 'new', updated_at = now()
      WHERE id = ${articleId} RETURNING revision`;
    await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${articleId}, ${r!.revision}, ${hash}, ${title}, ${bodyText})`;
    await invalidateRevisedMaterialTx(tx, articleId);
    return "ok";
  });
}

export { collapseWhitespace };
