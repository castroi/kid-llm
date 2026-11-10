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
  const own = new URL(baseURL!).origin;
  const outside: string[] = [];
  // Compared by origin, so a look-alike address (localhost:4173.example) counts as outside.
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== own) outside.push(request.url());
  });
  page.on('websocket', (socket) => outside.push(socket.url()));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'היי, על מה נדבר היום?' })).toBeVisible();
  expect(outside).toEqual([]);
});

test('the built app runs under the production security headers with nothing blocked', async ({ page }) => {
  const errors: string[] = [];
  // A browser reports anything the CSP blocks as a console error.
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  const response = await page.goto('/');
  const csp = response!.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(response!.headers()['x-content-type-options']).toBe('nosniff');

  // The script ran (the screen is there) and the stylesheet was applied (the modes are a grid).
  await expect(page.getByRole('heading', { name: 'היי, על מה נדבר היום?' })).toBeVisible();
  const display = await page.getByRole('group', { name: 'מצב' }).evaluate((grid) => getComputedStyle(grid).display);
  expect(display).toBe('grid');
  expect(errors).toEqual([]);
});

test('the CSP stops the page from sending anything to a site that is not on its list', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'היי, על מה נדבר היום?' })).toBeVisible();
  // Never reaches the network: the browser refuses first and says which rule refused.
  const refusedBy = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        document.addEventListener('securitypolicyviolation', (event) => resolve(event.violatedDirective));
        fetch('https://outside.example/collect', { method: 'POST', mode: 'no-cors', body: 'x' }).catch(() => undefined);
        setTimeout(() => resolve('not refused'), 3000);
      }),
  );
  expect(refusedBy).toBe('connect-src');
});
