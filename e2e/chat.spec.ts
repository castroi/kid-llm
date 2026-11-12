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

test('her own message has a copy button under it that is big enough to tap and stays on the screen', async ({ page }) => {
  await setUp(page);
  await expect(page.getByLabel('הודעה')).toBeVisible();
  // A chat put straight into the app's own database: nothing is sent to a provider.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('kid-llm');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('chats', 'readwrite');
          tx.objectStore('chats').put({
            id: 'talk',
            title: 'שמיים',
            mode: 'chat',
            createdAt: 1,
            updatedAt: 2,
            messages: [
              { id: 'q', role: 'user', text: 'למה השמיים כחולים? '.repeat(12), at: 1, mode: 'chat' },
              { id: 'a', role: 'assistant', text: 'בגלל האור של השמש.', at: 2, mode: 'chat' },
            ],
          });
          tx.onerror = () => reject(tx.error);
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
        };
      }),
  );
  await page.getByRole('button', { name: 'השיחות שלי' }).tap();
  await page.getByRole('dialog', { name: 'השיחות שלי' }).getByRole('button', { name: 'שמיים', exact: true }).tap();

  const mine = page.getByRole('button', { name: 'העתקה של ההודעה שלי' });
  await expect(mine).toBeVisible();
  // The answer keeps its own button, told apart by its name.
  await expect(page.getByRole('button', { name: 'העתקה', exact: true })).toBeVisible();

  const viewport = page.viewportSize()!;
  const size = (await mine.boundingBox())!;
  expect(size.height).toBeGreaterThanOrEqual(48);
  expect(size.width).toBeGreaterThanOrEqual(48);
  expect(size.x).toBeGreaterThanOrEqual(0);
  expect(size.x + size.width).toBeLessThanOrEqual(viewport.width);
  // It sits under her message, on her side of the screen (the right, in Hebrew).
  const bubble = (await page.locator('.bubble').boundingBox())!;
  expect(size.y).toBeGreaterThanOrEqual(bubble.y + bubble.height);
  expect(Math.round(size.x + size.width)).toBe(Math.round(bubble.x + bubble.width));
  // A long message still doesn't push the page sideways.
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(pageWidth).toBeLessThanOrEqual(viewport.width);
});
