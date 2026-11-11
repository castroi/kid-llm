import { expect, test } from '@playwright/test';

/* The list of chats at iPhone sizes. Opening, renaming and deleting chats are covered by the unit tests. */

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
