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

/** The longest site name shown, and the most parts ("a.b.c") a site's name may have. A name is words chosen by the site's owner. */
export const MAX_SITE_CHARS = 60;
export const MAX_SITE_LABELS = 5;

/**
 * The site's name as it is shown and as two links are told apart: the host without "www.".
 * null when the host is not an ordinary site name: a number address (also the phone itself
 * or a device at home), a single word ("localhost"), an empty part ("a..b", a trailing
 * dot), or a name too long to be one.
 */
function siteOf(url: URL): string | null {
  const labels = url.hostname.split('.');
  if (labels.length < 2 || labels.length > MAX_SITE_LABELS || labels.some((label) => label === '')) return null;
  // `URL` writes every number address (also "127.1" and "0x7f.1") as four numbers, so its last part is digits; no real site's is.
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  const site = url.hostname.replace(/^www\./, '');
  if (!site.includes('.') || site.length > MAX_SITE_CHARS) return null;
  return site;
}

/** The address as it may be linked: https on its usual port, to an ordinary site, with no name or password inside it. Otherwise null. */
function safeUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > MAX_SOURCE_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // Only https: never javascript:, data:, a file, or a plain http page. No other port: the name shown would hide it.
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || siteOf(url) === null) return null;
  return url;
}

/**
 * The name a link is shown by: its site ("he.wikipedia.org"), never the page's own title.
 * An international name is shown in its plain-letter form ("xn--..."), so a look-alike
 * letter can't pass for a known site. Empty when it isn't an address that may be linked.
 */
export function siteName(url: string): string {
  const safe = safeUrl(url);
  return safe ? (siteOf(safe) ?? '') : '';
}

/**
 * Sources out of whatever the provider sent, or whatever was stored: only safe https
 * addresses (the address kept is the one `URL` wrote, never the text as it came), one per site, at most `MAX_SOURCES`. Everything else of a citation (title,
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
    const site = siteOf(url);
    if (site === null || sites.has(site)) continue;
    sites.add(site);
    sources.push({ url: url.href });
  }
  return sources;
}
