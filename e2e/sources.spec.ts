import { expect, test } from '@playwright/test';

/* The links under a search answer at iPhone sizes. What becomes a link is covered by the unit tests. */

test('the sources of a saved search answer are links big enough to tap, shown by site name', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('הודעה')).toBeVisible();
  // A search chat put straight into the app's own database; one of its sources is not a safe address.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('kid-llm');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('chats', 'readwrite');
          tx.objectStore('chats').put({
            id: 'search',
            title: 'מי המציא את הטלפון?',
            mode: 'search',
            createdAt: 1,
            updatedAt: 2,
            messages: [
              { id: 'q', role: 'user', text: 'מי המציא את הטלפון?', at: 1, mode: 'search' },
              {
                id: 'a',
                role: 'assistant',
                text: 'אלכסנדר גרהם בל',
                at: 2,
                mode: 'search',
                sources: [{ url: 'https://he.wikipedia.org/wiki/Telephone', title: 'כותרת של דף' }, { url: 'javascript:alert(1)' }, { url: 'https://www.a-very-long-site-name-that-could-push-the-layout.example.com/' }],
              },
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
  await page.getByRole('dialog', { name: 'השיחות שלי' }).getByRole('button', { name: 'מי המציא את הטלפון?', exact: true }).tap();

  const links = page.getByRole('link');
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveText('he.wikipedia.org');
  await expect(links.first()).toHaveAttribute('href', 'https://he.wikipedia.org/wiki/Telephone');
  await expect(links.first()).toHaveAttribute('target', '_blank');
  await expect(links.first()).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.getByText('כותרת של דף')).toHaveCount(0);

  const viewport = page.viewportSize()!;
  for (const link of await links.all()) {
    const box = (await link.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(48);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  }
});
