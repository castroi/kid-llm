import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

/**
 * End-to-end tests against the production build (`vite preview`), in the browser jsdom
 * can't stand in for. Her phone is Safari, so the iPhone projects run WebKit.
 * Run `npm run build` first (CI does); `npm run test:e2e` does both.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One retry records a trace of a flaky failure; the run still fails, so flakiness never hides.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'he-IL',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Her phone, and the smallest iPhone screen the app should still fit.
    { name: 'iphone-14', use: { ...devices['iPhone 14'] } },
    { name: 'iphone-se', use: { ...devices['iPhone SE'] } },
  ],
  webServer: {
    command: `npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
