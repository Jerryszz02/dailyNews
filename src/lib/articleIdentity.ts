/** Reject listing and template links both during discovery and when republishing stored candidates. */
export function isNavigationCandidate(title: string, url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return true; }
  const path = parsed.pathname.toLowerCase().replace(/\/+$/, "");
  let decodedPath = path;
  try { decodedPath = decodeURIComponent(path); } catch { /* Keep the original malformed path. */ }
  if (/["']\s*\+|\+\s*["']|\$\{|\{\{/.test(decodedPath)) return true;
  if (!path || /^\/(home|index(?:\.html?)?|latest|china|sports|technology|science|business|section|sections)$/.test(path)) return true;
  if (/(^|\/)(tag|tags|search|sitemap|about|contact|terms|privacy|license)(\/|$)/.test(path)) return true;
  if (/(^|\/)(category|categories|topic|topics)(\/|$)/.test(path) && !/\.s?html?$/.test(path)) return true;
  if (/^\/(news|world|politics|finance|tech|gn|gj|cj|sh)(\/(world|politics|northern_ireland|northern_ireland_politics|uk|england|scotland|wales))*$/.test(path)) return true;
  if (/\/news-and-media\/news_[a-z]{2}$/.test(path)) return true;
  if (/\/news$/.test(path)) return true;
  if (/^\/betting\/news\/[^/]+$/.test(path)) return true;
  if (/^\/(world-rankings|stats-zone)(\/|$)/.test(path)) return true;
  if (/^\/competitions\/[^/]+\/20\d{2}$/.test(path)) return true;
  return /^(更多要闻播报|更多新闻|更多内容|网站导航|首页|首页新闻|uk politics|n\. ireland|northern ireland|feature stories|features|previews|reviews|latest news|photo stories|videos|watch live|more news)\s*[+＋]?$/i.test(title.trim());
}
