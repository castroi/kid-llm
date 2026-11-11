import { expect, test, type Page } from '@playwright/test';

/*
 * The parent area at iPhone sizes, with the real storage and the real code hashing of the
 * browser. Nothing here calls the provider ("בדיקת חיבור" is covered by the unit tests).
 */

test('a parent chooses a code and sets the chat up; then she can write, and the area asks for the code again', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText("הצ'אט עוד לא מוכן. צריך שאבא או אמא יגדירו אותו.")).toBeVisible();

  await page.getByRole('button', { name: 'אזור הורים' }).tap();
  await page.getByLabel('קוד חדש (4 עד 8 ספרות)').fill('2468');
  await page.getByLabel('שוב, לאימות').fill('2468');
  await page.getByRole('button', { name: 'שמירת הקוד' }).tap();

  await page.getByLabel('מפתח API').fill('not-a-real-key');
  await page.getByLabel('מודל למצב "שיחה"').fill('test-model');
  await page.getByLabel('שם הילדה').fill('נועה');
  await page.getByRole('button', { name: 'שמירה', exact: true }).tap();
  await expect(page.getByText('נשמר.', { exact: true })).toBeVisible();

  // Only a salted hash of the code is kept, and the key sits apart from the settings.
  const stored = await page.evaluate(() => ({
    pin: Object.keys(JSON.parse(localStorage.getItem('kid-llm.pin.v1') ?? '{}') as object).sort(),
    settings: localStorage.getItem('kid-llm.settings.v1') ?? '',
    key: localStorage.getItem('kid-llm.key.venice'),
  }));
  expect(stored.pin).toEqual(['hash', 'iterations', 'salt']);
  expect(stored.settings).not.toContain('not-a-real-key');
  expect(stored.key).toBe('not-a-real-key');

  await page.getByRole('button', { name: 'סיום' }).tap();
  await expect(page.getByRole('heading', { name: 'היי נועה, על מה נדבר היום?' })).toBeVisible();
  await page.getByLabel('הודעה').fill('שלום');
  await expect(page.getByRole('button', { name: 'שליחה' })).toBeEnabled();

  // Back in: the code is asked for, a wrong one keeps the settings closed, and the key is never shown.
  await page.getByRole('button', { name: 'אזור הורים' }).tap();
  await page.getByLabel('קוד הורים', { exact: true }).fill('1111');
  await page.getByRole('button', { name: 'כניסה' }).tap();
  await expect(page.getByText('קוד שגוי.')).toBeVisible();
  await expect(page.getByLabel('מפתח API')).toHaveCount(0);

  await page.getByLabel('קוד הורים', { exact: true }).fill('2468');
  await page.getByRole('button', { name: 'כניסה' }).tap();
  await expect(page.getByLabel('מפתח API')).toHaveValue('');
  expect(await page.content()).not.toContain('not-a-real-key');
});

test('the parent area fits the phone: fields do not make Safari zoom, buttons are big enough, nothing sticks out', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'אזור הורים' }).tap();
  await page.getByLabel('קוד חדש (4 עד 8 ספרות)').fill('2468');
  await page.getByLabel('שוב, לאימות').fill('2468');
  await page.getByRole('button', { name: 'שמירת הקוד' }).tap();
  await expect(page.getByLabel('מפתח API')).toBeVisible();

  for (const field of await page.locator('input, select, textarea').all()) {
    const fontSize = await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(16);
  }
  for (const button of await page.getByRole('button').all()) {
    const size = (await button.boundingBox())!;
    expect(size.height).toBeGreaterThanOrEqual(48);
  }
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  expect(widths.page).toBeLessThanOrEqual(widths.viewport);
});

/** How many chats the phone's own database holds. */
function chatsOnPhone(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('kid-llm');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const count = open.result.transaction('chats').objectStore('chats').count();
          count.onerror = () => reject(count.error);
          count.onsuccess = () => {
            open.result.close();
            resolve(count.result);
          };
        };
      }),
  );
}

test('"delete all chats" really empties the phone\'s database', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('הודעה')).toBeVisible();
  // A chat put straight into the app's own database, as a finished conversation would be.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('kid-llm');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('chats', 'readwrite');
          tx.objectStore('chats').put({
            id: 'seed',
            title: 'שיחה לבדיקה',
            mode: 'chat',
            createdAt: 1,
            updatedAt: 1,
            messages: [{ id: 'm1', role: 'user', text: 'שלום', at: 1, mode: 'chat' }],
          });
          tx.onerror = () => reject(tx.error);
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
        };
      }),
  );
  expect(await chatsOnPhone(page)).toBe(1);

  await page.getByRole('button', { name: 'אזור הורים' }).tap();
  await page.getByLabel('קוד חדש (4 עד 8 ספרות)').fill('2468');
  await page.getByLabel('שוב, לאימות').fill('2468');
  await page.getByRole('button', { name: 'שמירת הקוד' }).tap();
  await page.getByRole('button', { name: 'מחיקת כל השיחות' }).tap();
  await page.getByRole('button', { name: 'כן, למחוק הכול' }).tap();
  await expect(page.getByText('כל השיחות נמחקו מהאייפון.')).toBeVisible();
  expect(await chatsOnPhone(page)).toBe(0);
});
