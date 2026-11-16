/**
 * The file the build puts next to the app (vite.config.ts): the commit that is deployed now.
 * An open app compares it with the commit it was built from to tell that a newer one is out.
 */
export const VERSION_FILE = '/version.json';

const COMMIT = /^[0-9a-f]{40}$/;

/** A full commit name: 40 lowercase hex characters, nothing else. */
export function isCommit(value: unknown): value is string {
  return typeof value === 'string' && COMMIT.test(value);
}

/** The commit a version file names, or null for anything else. */
export function deployedCommit(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const commit = (body as { commit?: unknown }).commit;
  return isCommit(commit) ? commit : null;
}

/**
 * Asks the site which commit is deployed now. Null when it can't tell: offline, an error,
 * a redirect, or an answer that isn't a version file. Never throws. The request goes to the
 * site's own origin only, past every cache, and carries nothing of hers.
 */
export async function fetchDeployedCommit(fetchFn: typeof fetch): Promise<string | null> {
  try {
    const response = await fetchFn(VERSION_FILE, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (!response.ok) return null;
    return deployedCommit(await response.json());
  } catch {
    return null;
  }
}
