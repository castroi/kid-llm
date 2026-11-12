import { execFileSync } from 'node:child_process';
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import vercel from './vercel.json';

/**
 * `vite preview` (the e2e server) sends the same security headers as the deployed site,
 * so the Playwright tests run the built app under the real CSP.
 */
const siteHeaders = Object.fromEntries((vercel.headers.find((rule) => rule.source === '/(.*)')?.headers ?? []).map((h) => [h.key, h.value]));

/** One fact about the commit being built, or '' when git can't say (no git, or no history). */
function fromGit(format: string): string {
  try {
    return execFileSync('git', ['log', '-1', `--format=${format}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/**
 * Which commit this build is, for the version line in the parent area. Vercel names the
 * commit it deploys; anywhere else git does. The app checks both values before it shows
 * them (src/core/version.ts), so an odd value ends up as "dev", never as a link.
 */
const head = fromGit('%H');
const commit = process.env.VERCEL_GIT_COMMIT_SHA || head;
// The date is git's, so it is taken only when git is looking at that same commit.
const commitDate = commit !== '' && commit === head ? fromGit('%cI') : '';

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_COMMIT__: JSON.stringify(commit),
    __APP_COMMIT_DATE__: JSON.stringify(commitDate),
  },
  preview: { headers: siteHeaders },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // e2e/ is Playwright's (npm run test:e2e), run in real browsers, not jsdom.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      // Tests, test helpers, and the app bootstrap that only a real browser runs.
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx'],
      // CI fails below these, so new code arrives with its tests.
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75,
        // The code that carries the key and her chats is held to a higher bar.
        'src/ai/**': { lines: 90, statements: 90, functions: 90, branches: 80 },
      },
    },
  },
});
