import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import vercel from './vercel.json';

/**
 * `vite preview` (the e2e server) sends the same security headers as the deployed site,
 * so the Playwright tests run the built app under the real CSP.
 */
const siteHeaders = Object.fromEntries((vercel.headers.find((rule) => rule.source === '/(.*)')?.headers ?? []).map((h) => [h.key, h.value]));

export default defineConfig({
  plugins: [react()],
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
