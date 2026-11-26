import { expect, test, type Page } from '@playwright/test';

/*
 * Files older than two weeks, in the real browser: the small copy of a picture is drawn by a
 * real canvas, which jsdom doesn't have. Nothing here sends a message.
 */

const DAY = 24 * 60 * 60 * 1000;

async function setUp(page: Page) {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem(
      'kid-llm.settings.v1',
      JSON.stringify({ provider: 'venice', models: { chat: 'test-model' }, fileModel: 'vision-model', fileModelImages: 5, systemPrompt: '', childName: '', dailyLimit: null }),
    );
    localStorage.setItem('kid-llm.key.venice', 'not-a-real-key');
  });
  await page.reload();
  await expect(page.getByLabel('הודעה')).toBeVisible();
}

/** Puts a chat with an old photo and document, and a newer document, on the phone, as the app keeps them. */
async function keepOldChat(page: Page, sentAt: number) {
  await page.evaluate(async (at) => {
    // A cleanup the first opening may have run already must not count for the next one.
    localStorage.removeItem('kid-llm.trimmed-at.v1');
    const canvas = document.createElement('canvas');
    canvas.width = 1568;
    canvas.height = 784;
    const pen = canvas.getContext('2d')!;
    pen.fillStyle = '#336699';
    pen.fillRect(0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/jpeg', 0.85));
    const photo = await jpeg.arrayBuffer();
    const pdf = new TextEncoder().encode('%PDF-1.7 homework').buffer;
    const chat = {
      id: 'old-chat',
      title: 'דף עבודה',
      mode: 'chat',
      createdAt: at,
      updatedAt: Date.now(),
      messages: [
        { id: 'q1', role: 'user', text: 'מה בתמונה?', at, mode: 'chat', attachments: [{ kind: 'image', bytes: photo, name: 'הכיתה.jpg' }, { kind: 'pdf', bytes: pdf, name: 'דף של נועה.pdf' }] },
        { id: 'a1', role: 'assistant', text: 'לוח כחול', at: at + 1, mode: 'chat' },
        { id: 'q2', role: 'user', text: 'ועוד דף', at: Date.now(), mode: 'chat', attachments: [{ kind: 'pdf', bytes: pdf, name: 'חדש.pdf' }] },
      ],
    };
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('kid-llm');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('chats', 'readwrite');
        tx.objectStore('chats').put(chat);
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, sentAt);
}

async function kept(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ trimmed: (boolean | undefined)[]; names: string[]; sizes: number[]; side: number }>((resolve, reject) => {
        const open = indexedDB.open('kid-llm');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction('chats').objectStore('chats').get('old-chat');
          get.onsuccess = () => {
            open.result.close();
            const files = (get.result as { messages: { attachments?: { kind: string; name: string; bytes: ArrayBuffer; trimmed?: boolean }[] }[] }).messages.flatMap((m) => m.attachments ?? []);
            createImageBitmap(new Blob([files[0].bytes], { type: 'image/jpeg' })).then(
              (picture) => resolve({ trimmed: files.map((f) => f.trimmed), names: files.map((f) => f.name), sizes: files.map((f) => f.bytes.byteLength), side: Math.max(picture.width, picture.height) }),
              reject,
            );
          };
          get.onerror = () => reject(get.error);
        };
      }),
  );
}

test('a few seconds after the app opens, files older than two weeks are trimmed: a picture to a small copy, a document to a note', async ({ page }) => {
  await setUp(page);
  await keepOldChat(page, Date.now() - 15 * DAY);
  await page.reload();
  await expect(page.getByLabel('הודעה')).toBeVisible();

  await expect.poll(async () => (await kept(page)).trimmed, { timeout: 20_000 }).toEqual([true, true, undefined]);
  const after = await kept(page);
  // The picture is redrawn with its long side at 640; the old document has no bytes and no name left; the newest file is whole.
  expect(after.side).toBe(640);
  expect(after.names).toEqual(['', '', 'חדש.pdf']);
  expect(after.sizes[1]).toBe(0);
  expect(after.sizes[2]).toBeGreaterThan(0);

  // Opened from her list, the chat shows what is left.
  await page.getByRole('button', { name: 'השיחות שלי' }).tap();
  await page.getByRole('dialog', { name: 'השיחות שלי' }).getByRole('button', { name: 'דף עבודה', exact: true }).tap();
  await expect(page.locator('.bubble').first().getByText('עותק קטן')).toBeVisible();
  await expect(page.locator('.attached-file.trimmed')).toContainText('הקובץ נמחק אחרי שבועיים');
});

test('files from the last two weeks are kept whole', async ({ page }) => {
  await setUp(page);
  await keepOldChat(page, Date.now() - 3 * DAY);
  await page.reload();
  await expect(page.getByLabel('הודעה')).toBeVisible();
  await page.waitForTimeout(8_000);
  expect((await kept(page)).trimmed).toEqual([undefined, undefined, undefined]);
});
