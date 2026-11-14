import { expect, test, type Page } from '@playwright/test';

/* Addresses in the model's own text at iPhone sizes: links in a parent's own use, text for her. What becomes a link is covered by the unit tests. */

const ADDRESS = 'https://www.google.com/search?q=18V';

/** Opens the app with these settings and one saved chat whose answer gives an address, and shows that chat. */
async function openChat(page: Page, parentUse: boolean) {
  await page.addInitScript((parentUse) => {
    localStorage.setItem(
      'kid-llm.settings.v1',
      JSON.stringify({ provider: 'venice', models: { chat: 'test-model' }, systemPrompt: '', childName: '', dailyLimit: null, ...(parentUse ? { parentUse: true } : {}) }),
    );
    localStorage.setItem('kid-llm.key.venice', 'not-a-real-key');
  }, parentUse);
  await page.goto('/');
  await expect(page.getByLabel('הודעה')).toBeVisible();
  await page.evaluate(
    (address) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('kid-llm');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('chats', 'readwrite');
          tx.objectStore('chats').put({
            id: 'links',
            title: 'סוללה',
            mode: 'chat',
            createdAt: 1,
            updatedAt: 2,
            messages: [
              { id: 'q', role: 'user', text: 'איפה קונים סוללה?', at: 1, mode: 'chat' },
              { id: 'a', role: 'assistant', text: `אפשר לחפש כאן: [לחץ כאן לחיפוש](${address})`, at: 2, mode: 'chat' },
            ],
          });
          tx.onerror = () => reject(tx.error);
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
        };
      }),
    ADDRESS,
  );
  await page.getByRole('button', { name: 'השיחות שלי' }).tap();
  await page.getByRole('dialog', { name: 'השיחות שלי' }).getByRole('button', { name: 'סוללה', exact: true }).tap();
  await expect(page.getByText('איפה קונים סוללה?')).toBeVisible();
}

test("in a parent's own use, an address in the answer is a link big enough to tap, shown by site name", async ({ page }) => {
  await openChat(page, true);
  const link = page.getByRole('link', { name: 'google.com' });
  await expect(link).toHaveAttribute('href', ADDRESS);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  const box = (await link.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(48);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test('for her, the same answer has no link', async ({ page }) => {
  await openChat(page, false);
  await expect(page.getByText(ADDRESS)).toBeVisible();
  await expect(page.getByRole('link')).toHaveCount(0);
});
