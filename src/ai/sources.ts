/**
 * The websites a search answer was drawn from, as the app keeps and shows them. The
 * provider sends a title, an address, the page's text and a date for each; only the
 * address is kept. A page's title and text are written by whoever made the page, pass no
 * child-safety check, and are never shown to her: a link is shown by the name of its site.
 */
export interface Source {
  /** An https address, as `URL` writes it. */
  url: string;
}

/** The most links shown under one answer. */
export const MAX_SOURCES = 5;
/** Longer than any real address; a longer one is dropped. */
export const MAX_SOURCE_URL_CHARS = 2_000;

/** The address as it may be linked: https only, with no name or password inside it. Otherwise null. */
function safeUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > MAX_SOURCE_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // Only https: never javascript:, data:, a file, or a plain http page.
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || !url.hostname.includes('.')) return null;
  return url;
}

const withoutWww = (hostname: string) => hostname.replace(/^www\./, '');

/**
 * The name a link is shown by: its site ("he.wikipedia.org"), never the page's own title.
 * An international name is shown in its plain-letter form ("xn--..."), so a look-alike
 * letter can't pass for a known site. Empty when it isn't an address.
 */
export function siteName(url: string): string {
  try {
    return withoutWww(new URL(url).hostname);
  } catch {
    return '';
  }
}

/**
 * Sources out of whatever the provider sent, or whatever was stored: only safe https
 * addresses, one per site, at most `MAX_SOURCES`. Everything else of a citation (title,
 * page text, date, unknown fields) is dropped. Never throws.
 */
export function sanitizeSources(raw: unknown): Source[] {
  if (!Array.isArray(raw)) return [];
  const sources: Source[] = [];
  const sites = new Set<string>();
  for (const item of raw) {
    if (sources.length >= MAX_SOURCES) break;
    if (!item || typeof item !== 'object') continue;
    const url = safeUrl((item as { url?: unknown }).url);
    if (!url) continue;
    const site = withoutWww(url.hostname);
    if (sites.has(site)) continue;
    sites.add(site);
    sources.push({ url: url.href });
  }
  return sources;
}
