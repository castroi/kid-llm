import { expect, test } from '@playwright/test';

/*
 * Playwright's iPhone viewports are the screen minus Safari's bars. It can't show the
 * notch or the home indicator (env(safe-area-inset-*) is 0 here): check those on her phone.
 */

test('the opening screen is in Hebrew, right to left, and fits the width of the phone', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'היי, על מה נדבר היום?' })).toBeVisible();

  const box = await page.evaluate(() => ({
    dir: document.documentElement.dir,
    lang: document.documentElement.lang,
    viewportWidth: document.documentElement.clientWidth,
    pageWidth: document.documentElement.scrollWidth,
  }));
  expect(box.dir).toBe('rtl');
  expect(box.lang).toBe('he');
  // Nothing sticks out sideways.
  expect(box.pageWidth).toBeLessThanOrEqual(box.viewportWidth);
});

test('every mode is a touch target a kid can hit, and tapping one selects it', async ({ page }) => {
  await page.goto('/');
  const modes = page.getByRole('group', { name: 'מצב' }).getByRole('button');
  await expect(modes).toHaveCount(4);
  for (const mode of await modes.all()) {
    const size = await mode.boundingBox();
    expect(size!.width).toBeGreaterThanOrEqual(48);
    expect(size!.height).toBeGreaterThanOrEqual(48);
  }

  const math = page.getByRole('button', { name: /חשבון/ });
  await math.tap();
  await expect(math).toHaveAttribute('aria-pressed', 'true');
});

test('the page asks no other site for anything', async ({ page, baseURL }) => {
  const outside: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(baseURL!)) outside.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'היי, על מה נדבר היום?' })).toBeVisible();
  expect(outside).toEqual([]);
});
