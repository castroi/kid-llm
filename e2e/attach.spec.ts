import { deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';

/*
 * Attaching a file at iPhone sizes, in the real browser: redrawing a picture needs a real
 * canvas, which jsdom doesn't have. Nothing here sends a message (see chat.spec.ts).
 */

/** A phone a parent has set up, with a model for files. The key is a made-up value that is never sent. */
async function setUp(page: Page) {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem(
      'kid-llm.settings.v1',
      JSON.stringify({ provider: 'venice', models: { chat: 'test-model', math: 'test-model', search: 'test-model' }, fileModel: 'vision-model', systemPrompt: '', childName: '', dailyLimit: null }),
    );
    localStorage.setItem('kid-llm.key.venice', 'not-a-real-key');
  });
  await page.reload();
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, sum]);
}

/** A real PNG of one colour, made here so the test needs no picture file. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  const row = Buffer.alloc(1 + width * 3, 0x66);
  row[0] = 0; // no filter
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', new Uint8Array(0))]);
}

test('without a model for files there is no attach button', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('kid-llm.settings.v1', JSON.stringify({ provider: 'venice', models: { chat: 'test-model' }, systemPrompt: '', childName: '', dailyLimit: null }));
    localStorage.setItem('kid-llm.key.venice', 'not-a-real-key');
  });
  await page.reload();
  await expect(page.getByLabel('הודעה')).toBeVisible();
  await expect(page.getByRole('button', { name: 'צירוף קובץ' })).toHaveCount(0);
});

test('a picture she picks is redrawn under the production security headers and waits in the message box', async ({ page }) => {
  const blocked: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') blocked.push(message.text());
  });
  await setUp(page);

  const button = page.getByRole('button', { name: 'צירוף קובץ' });
  await expect(button).toBeVisible();
  const size = (await button.boundingBox())!;
  expect(size.width).toBeGreaterThanOrEqual(48);
  expect(size.height).toBeGreaterThanOrEqual(48);

  await page.getByLabel('קובץ לצירוף').setInputFiles({ name: 'IMG_0042.png', mimeType: 'image/png', buffer: png(200, 120) });
  // The picture was opened and redrawn (the CSP allows blob: pictures), and waits under a plain word.
  await expect(page.locator('.attachment-chip')).toHaveText('תמונה');
  const remove = page.getByRole('button', { name: 'הסרת הקובץ' });
  const removeSize = (await remove.boundingBox())!;
  expect(removeSize.height).toBeGreaterThanOrEqual(48);

  // The composer still fits the phone, and send wakes up once she writes.
  const viewport = page.viewportSize()!;
  await page.getByLabel('הודעה').fill('מה יש בתמונה?');
  const send = page.getByRole('button', { name: 'שליחה' });
  await expect(send).toBeEnabled();
  const sendBox = (await send.boundingBox())!;
  expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(viewport.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);

  await remove.tap();
  await expect(page.locator('.attachment-chip')).toHaveCount(0);
  expect(blocked).toEqual([]);
});

test('a file that is not a picture or a document is refused with a friendly line', async ({ page }) => {
  await setUp(page);
  await page.getByLabel('קובץ לצירוף').setInputFiles({ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('this is not a picture at all') });
  await expect(page.getByText('לא הצלחתי לפתוח את הקובץ הזה. ננסה קובץ אחר?')).toBeVisible();
  await expect(page.locator('.attachment-chip')).toHaveCount(0);

  await page.getByLabel('קובץ לצירוף').setInputFiles({ name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<html></html>') });
  await expect(page.getByText('אפשר לצרף רק תמונה או מסמך.')).toBeVisible();
});

test('the attach button is not offered in search mode', async ({ page }) => {
  await setUp(page);
  await expect(page.getByRole('button', { name: 'צירוף קובץ' })).toBeVisible();
  await page.getByRole('group', { name: 'מצב' }).getByRole('button', { name: /חיפוש/ }).tap();
  await expect(page.getByRole('button', { name: 'צירוף קובץ' })).toHaveCount(0);
});
