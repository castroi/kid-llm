import { expect, test, type Page } from '@playwright/test';

/*
 * The chat screen at iPhone sizes. Nothing here sends a message: a real send would call
 * the provider from CI (Playwright's WebKit on Linux can't stand in for a cross-origin call).
 * Sending, stopping and failures are covered by the unit tests in src/app/App.test.tsx.
 */

/** A phone a parent has already set up. The key is a made-up value that is never sent. */
async function setUp(page: Page) {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem(
      'kid-llm.settings.v1',
      JSON.stringify({ provider: 'venice', models: { chat: 'test-model', math: 'test-model' }, systemPrompt: '', childName: 'נועה', dailyLimit: null }),
    );
    localStorage.setItem('kid-llm.key.venice', 'not-a-real-key');
  });
  await page.reload();
}

test('before a parent sets it up, she is told to call a parent and cannot send', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText("הצ'אט עוד לא מוכן. צריך שאבא או אמא יגדירו אותו.")).toBeVisible();
  await page.getByLabel('הודעה').fill('שלום');
  await expect(page.getByRole('button', { name: 'שליחה' })).toBeDisabled();
});

test('the message box stays on screen, is big enough not to make Safari zoom, and send wakes up when she types', async ({ page }) => {
  await setUp(page);
  await expect(page.getByRole('heading', { name: 'היי נועה, על מה נדבר היום?' })).toBeVisible();

  const input = page.getByLabel('הודעה');
  await expect(input).toBeVisible();
  const fontSize = await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);

  const send = page.getByRole('button', { name: 'שליחה' });
  await expect(send).toBeDisabled();
  await input.fill('למה השמיים כחולים?');
  await expect(send).toBeEnabled();

  // The whole composer is inside the screen, and nothing sticks out sideways.
  const viewport = page.viewportSize()!;
  const sendBox = (await send.boundingBox())!;
  expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(viewport.height);
  expect(sendBox.width).toBeGreaterThanOrEqual(48);
  expect(sendBox.height).toBeGreaterThanOrEqual(48);
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(pageWidth).toBeLessThanOrEqual(viewport.width);
});

test('the box grows with a long message, up to a few lines', async ({ page }) => {
  await setUp(page);
  const input = page.getByLabel('הודעה');
  const oneLine = (await input.boundingBox())!.height;
  await input.fill(Array.from({ length: 12 }, (_, i) => `שורה ${i + 1}`).join('\n'));
  const grown = (await input.boundingBox())!.height;
  expect(grown).toBeGreaterThan(oneLine);
  expect(grown).toBeLessThanOrEqual(141);
  await expect(page.getByRole('button', { name: 'שליחה' })).toBeInViewport();
});

test('the mode picker opens from the chip, fits the screen, and changes the mode', async ({ page }) => {
  await setUp(page);
  await page.getByRole('button', { name: 'שיחה', exact: true }).tap();
  const sheet = page.getByRole('dialog', { name: 'במה להשתמש עכשיו?' });
  await expect(sheet).toBeVisible();
  const rows = sheet.getByRole('button');
  await expect(rows).toHaveCount(4);
  const viewport = page.viewportSize()!;
  for (const row of await rows.all()) {
    const size = (await row.boundingBox())!;
    expect(size.height).toBeGreaterThanOrEqual(48);
    expect(size.y + size.height).toBeLessThanOrEqual(viewport.height);
  }

  await sheet.getByRole('button', { name: /חשבון/ }).tap();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('button', { name: 'חשבון', exact: true })).toBeVisible();
});
