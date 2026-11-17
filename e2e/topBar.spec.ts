import { expect, test, type Page } from '@playwright/test';

/*
 * The top bar stays on the screen. On the iPhone the keyboard pushes the page itself up, and
 * after a filtered list got shorter iOS left it there once the keyboard closed: the top bar
 * ("אזור הורים", "סיום") stayed under the status bar, blurred by iOS 26, with an empty strip
 * at the bottom. Here the page is made taller than the screen on purpose, the way the
 * keyboard makes it on a phone, so that a page scroll can happen at all.
 */

/** A phone a parent has already set up, with one long chat in the app's own database. Nothing is sent to a provider. */
async function setUpWithChat(page: Page) {
  await page.goto('/');
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        localStorage.setItem(
          'kid-llm.settings.v1',
          JSON.stringify({ provider: 'venice', models: { chat: 'test-model', math: 'test-model' }, systemPrompt: '', childName: 'נועה', dailyLimit: null }),
        );
        localStorage.setItem('kid-llm.key.venice', 'not-a-real-key');
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
              { id: 'q', role: 'user', text: 'למה השמיים כחולים? '.repeat(30), at: 1, mode: 'chat' },
              { id: 'a', role: 'assistant', text: 'בגלל האור של השמש. '.repeat(60), at: 2, mode: 'chat' },
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
  await page.reload();
}

/** Room under the app, so the page itself can scroll, as it can on a phone with the keyboard up. */
async function makePageScrollable(page: Page) {
  await page.evaluate(() => {
    const room = document.createElement('div');
    room.style.height = '1500px';
    document.body.append(room);
  });
}

async function expectOnScreen(page: Page, name: string, role: 'heading' | 'button') {
  const box = (await page.getByRole(role, { name, exact: true }).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
}

test('opening a chat scrolls the conversation, not the page', async ({ page }) => {
  await setUpWithChat(page);
  await makePageScrollable(page);
  await page.getByRole('button', { name: 'השיחות שלי' }).tap();
  await page.getByRole('dialog', { name: 'השיחות שלי' }).getByRole('button', { name: 'שמיים', exact: true }).tap();
  await expect(page.getByRole('heading', { name: 'שמיים' })).toBeVisible();

  // The newest answer is in view inside the conversation's own box...
  const scroll = page.locator('main.scroll');
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // ...and the page itself has not moved, so the top bar is still on the screen.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expectOnScreen(page, 'שמיים', 'heading');
});

/** In the parent area, past the code, with the page able to scroll. */
async function openParentArea(page: Page) {
  await setUpWithChat(page);
  await makePageScrollable(page);
  await page.getByRole('button', { name: 'השיחות שלי' }).tap();
  await page.getByRole('button', { name: 'אזור הורים' }).tap();
  await page.getByLabel('קוד חדש (4 עד 8 ספרות)').fill('2468');
  await page.getByLabel('שוב, לאימות').fill('2468');
  await page.getByRole('button', { name: 'שמירת הקוד' }).tap();
  await expect(page.getByLabel('מפתח API')).toBeVisible();
}

test('in the parent area, the page pushed up by the keyboard goes back down once the field is left', async ({ page }) => {
  await openParentArea(page);

  // What the keyboard does on the iPhone: a field is typed in, and the page goes up to keep it in view.
  const field = page.getByLabel('מפתח API');
  await field.focus();
  await page.evaluate(() => window.scrollTo(0, 300));
  // While she types, the page stays where the keyboard put it.
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  // The keyboard closes. iOS sometimes leaves the page up; the app brings it back.
  await field.blur();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expectOnScreen(page, 'אזור הורים', 'heading');
  await expectOnScreen(page, 'סיום', 'button');
});

test('in the parent area, a page scrolled with no field in use goes straight back to the top', async ({ page }) => {
  await openParentArea(page);
  await page.getByRole('heading', { name: 'חיבור' }).click();
  await page.evaluate(() => window.scrollTo(0, 300));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expectOnScreen(page, 'אזור הורים', 'heading');
  await expectOnScreen(page, 'סיום', 'button');
});
