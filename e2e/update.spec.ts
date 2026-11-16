import { execFileSync } from 'node:child_process';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/*
 * The update notice against the production build. The build writes version.json with its own
 * commit; here the tests stand in for a newer deployment by answering that file themselves.
 */

const UPDATE_MESSAGE = 'יש גרסה חדשה של האפליקציה.';
const NEWER = 'f'.repeat(40);

/** The commit the built site says it serves, or null for a build that doesn't know its commit. */
async function builtCommit(request: APIRequestContext): Promise<string | null> {
  const response = await request.get('/version.json');
  if (!response.ok()) return null;
  const body = (await response.json()) as { commit?: unknown };
  return typeof body.commit === 'string' ? body.commit : null;
}

/** Answers the app's version file with whatever `site.commit` is at the time it asks. */
async function standInForTheSite(page: Page, site: { commit: string }) {
  await page.route('**/version.json', (route) => route.fulfill({ json: { commit: site.commit }, headers: { 'Cache-Control': 'no-store' } }));
}

/** Opens the app and waits until it has asked which version the site serves. */
async function openAndWaitForTheAsk(page: Page) {
  const asked = page.waitForResponse('**/version.json');
  await page.goto('/');
  await asked;
}

test('the built site says which commit it serves: the commit the app was built from', async ({ request }) => {
  const commit = await builtCommit(request);
  if (process.env.CI) {
    // CI builds from a git checkout, so the file must be there and name that commit.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(commit).toBe(head);
  } else {
    test.skip(commit === null, 'built without a commit: there is no version file and the app never asks');
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
  }
});

test.describe('with a newer version deployed', () => {
  test.beforeEach(async ({ request }) => {
    test.skip((await builtCommit(request)) === null, 'built without a commit: the app never asks');
  });

  test('she is told, with buttons a kid can hit, and "אחר כך" puts it away', async ({ page }) => {
    await standInForTheSite(page, { commit: NEWER });
    await openAndWaitForTheAsk(page);

    await expect(page.getByText(UPDATE_MESSAGE)).toBeVisible();
    const viewport = page.viewportSize()!;
    for (const name of ['לעדכן', 'אחר כך']) {
      const size = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(size.height).toBeGreaterThanOrEqual(48);
      expect(size.width).toBeGreaterThanOrEqual(48);
      expect(size.x).toBeGreaterThanOrEqual(0);
      expect(size.x + size.width).toBeLessThanOrEqual(viewport.width);
    }
    // Nothing sticks out sideways on the smallest iPhone.
    const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    expect(widths.page).toBeLessThanOrEqual(widths.viewport);

    await page.getByRole('button', { name: 'אחר כך', exact: true }).tap();
    await expect(page.getByText(UPDATE_MESSAGE)).toHaveCount(0);
  });

  test('"לעדכן" loads the new version, and what the parent set up is still there', async ({ page, request }) => {
    const site = { commit: NEWER };
    await standInForTheSite(page, site);
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('kid-llm.settings.v1', JSON.stringify({ provider: 'venice', models: { chat: 'test-model' }, systemPrompt: '', childName: 'נועה', dailyLimit: null }));
    });
    await openAndWaitForTheAsk(page);
    await expect(page.getByText(UPDATE_MESSAGE)).toBeVisible();
    // Marks this page, to tell that the next one is a fresh load.
    await page.evaluate(() => ((window as unknown as { beforeUpdate: boolean }).beforeUpdate = true));

    // Once loaded, the app is the version the site serves.
    site.commit = (await builtCommit(request))!;
    const asked = page.waitForResponse('**/version.json');
    await page.getByRole('button', { name: 'לעדכן', exact: true }).tap();
    await asked;

    expect(await page.evaluate(() => (window as unknown as { beforeUpdate?: boolean }).beforeUpdate)).toBeUndefined();
    await expect(page.getByRole('heading', { name: 'היי נועה, על מה נדבר היום?' })).toBeVisible();
    await expect(page.getByText(UPDATE_MESSAGE)).toHaveCount(0);
  });
});

test('nothing is said while the site serves this same version, and the app asks again when it comes back to the screen', async ({ page, request }) => {
  const commit = await builtCommit(request);
  test.skip(commit === null, 'built without a commit: the app never asks');
  const site = { commit: commit! };
  await standInForTheSite(page, site);
  await openAndWaitForTheAsk(page);
  await expect(page.getByRole('heading', { name: 'היי, על מה נדבר היום?' })).toBeVisible();
  await expect(page.getByText(UPDATE_MESSAGE)).toHaveCount(0);

  // A new version is deployed while the app sits in the background; she comes back to it.
  site.commit = NEWER;
  const asked = page.waitForResponse('**/version.json');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await asked;
  await expect(page.getByText(UPDATE_MESSAGE)).toBeVisible();
});
