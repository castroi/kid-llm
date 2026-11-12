import { expect, test } from '@playwright/test';

/* The list of chats at iPhone sizes. Opening and renaming chats are covered by the unit tests; she can't delete one. */

test('the list of chats slides in from the right, fits the phone, and closes with a tap outside', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'השיחות שלי' }).tap();
  const drawer = page.getByRole('dialog', { name: 'השיחות שלי' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('עוד אין שיחות שמורות.')).toBeVisible();

  const viewport = page.viewportSize()!;
  const box = (await drawer.boundingBox())!;
  // Hebrew reads from the right, so the list sits against the right edge and leaves room to tap outside.
  expect(Math.round(box.x + box.width)).toBe(viewport.width);
  expect(box.width).toBeLessThan(viewport.width - 40);
  expect(box.height).toBeLessThanOrEqual(viewport.height);

  for (const button of await drawer.getByRole('button').all()) {
    const size = (await button.boundingBox())!;
    expect(size.height).toBeGreaterThanOrEqual(48);
    expect(size.y + size.height).toBeLessThanOrEqual(viewport.height);
  }

  // A tap on the part of the screen the list doesn't cover.
  await page.touchscreen.tap(20, viewport.height / 2);
  await expect(drawer).toBeHidden();
});

test('a saved picture is shown under the production security headers', async ({ page }) => {
  const blocked: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') blocked.push(message.text());
  });
  await page.goto('/');
  await expect(page.getByLabel('הודעה')).toBeVisible();
  // A drawing chat put straight into the app's own database, with a real one-pixel PNG.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
        const open = indexedDB.open('kid-llm');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('chats', 'readwrite');
          tx.objectStore('chats').put({
            id: 'drawing',
            title: 'נקודה אדומה',
            mode: 'draw',
            createdAt: 1,
            updatedAt: 2,
            messages: [
              { id: 'q', role: 'user', text: 'נקודה אדומה', at: 1, mode: 'draw' },
              { id: 'a', role: 'assistant', text: '', at: 2, mode: 'draw', image: { type: 'image/png', bytes: png.buffer } },
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
  await page.getByRole('dialog', { name: 'השיחות שלי' }).getByRole('button', { name: 'נקודה אדומה', exact: true }).tap();
  const picture = page.getByRole('img', { name: 'התמונה שציירתי' });
  await expect(picture).toBeVisible();
  // It really loaded (the CSP allows blob: pictures), and it fits the width of the phone.
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  expect(await picture.getAttribute('src')).toMatch(/^blob:/);
  const box = (await picture.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(blocked).toEqual([]);
});
