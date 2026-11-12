/** Put in by the build (vite.config.ts): the commit that was built and when it was made. */
declare const __APP_COMMIT__: string;
declare const __APP_COMMIT_DATE__: string;

export const REPO_URL = 'https://github.com/castroi/kid-llm';

export interface AppVersion {
  /** The first 7 characters of the commit, or "dev" for a build that doesn't know its commit. */
  label: string;
  /** That commit on GitHub, or the repository itself for "dev". */
  url: string;
  /** When the commit was made; null when the build doesn't know. */
  date: Date | null;
}

/**
 * The version line of the parent area. The link is built only from a full commit name
 * (40 hex characters), so nothing else the build was given can become part of an address.
 */
export function appVersion(commit: string, commitDate: string): AppVersion {
  if (!/^[0-9a-f]{40}$/.test(commit)) return { label: 'dev', url: REPO_URL, date: null };
  const at = Date.parse(commitDate);
  return { label: commit.slice(0, 7), url: `${REPO_URL}/commit/${commit}`, date: Number.isNaN(at) ? null : new Date(at) };
}

/** This build. */
export const APP_VERSION: AppVersion = appVersion(__APP_COMMIT__, __APP_COMMIT_DATE__);
