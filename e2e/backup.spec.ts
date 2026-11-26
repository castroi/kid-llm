import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/*
 * Backup at iPhone sizes, with the browser's real storage and real files. On her iPhone the
 * file leaves through the share sheet, which a test can't drive; here the browser is told it
 * can't share files, so the file is downloaded and read.
 */

/** What the phone's own database holds: how many chats, and the bytes of the seeded picture. */
function onPhone(page: Page): Promise<{ chats: number; picture: number[] }> {
  return page.evaluate(
    () =>
      new Promise<{ chats: number; picture: number[] }>((resolve, reject) => {
        const open = indexedDB.open('kid-llm');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction('chats').objectStore('chats').getAll();
          all.onerror = () => reject(all.error);
          all.onsuccess = () => {
            open.result.close();
            const records = all.result as { messages: { image?: { bytes: ArrayBuffer } }[] }[];
            const image = records[0]?.messages[1]?.image;
            resolve({ chats: records.length, picture: image ? Array.from(new Uint8Array(image.bytes)) : [] });
          };
        };
      }),
  );
}

const PICTURE = [82, 73, 70, 70, 0, 255, 7, 9, 200, 13, 10, 0];

test('a backup file brings the chats and their pictures back after "delete all", and holds no key', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
  });
  await page.goto('/');
  await expect(page.getByLabel('הודעה')).toBeVisible();
  // A chat with a picture, put straight into the app's own database as a finished drawing would be.
  await page.evaluate(
    (picture) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('kid-llm');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('chats', 'readwrite');
          tx.objectStore('chats').put({
            id: 'seed',
            title: 'שיחה לבדיקה',
            mode: 'draw',
            createdAt: 1,
            updatedAt: 2,
            messages: [
              { id: 'm1', role: 'user', text: 'חתול על סקייטבורד', at: 1, mode: 'draw' },
              { id: 'm2', role: 'assistant', text: '', at: 2, mode: 'draw', image: { type: 'image/webp', bytes: new Uint8Array(picture).buffer } },
            ],
          });
          tx.onerror = () => reject(tx.error);
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
        };
      }),
    PICTURE,
  );

  await page.getByRole('button', { name: 'השיחות שלי' }).tap();
  await page.getByRole('button', { name: 'אזור הורים' }).tap();
  await page.getByLabel('קוד חדש (4 עד 8 ספרות)').fill('2468');
  await page.getByLabel('שוב, לאימות').fill('2468');
  await page.getByRole('button', { name: 'שמירת הקוד' }).tap();
  await page.getByLabel('מפתח API').fill('not-a-real-key');
  await page.getByLabel('שם הילדה').fill('נועה');
  await page.getByRole('button', { name: 'שמירה', exact: true }).tap();
  await expect(page.getByText('נשמר.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'הכנת קובץ גיבוי' }).tap();
  await expect(page.getByText('הקובץ מוכן: שיחה אחת')).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'שמירת הקובץ' }).tap();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^kid-llm-backup-\d{4}-\d{2}-\d{2}\.kidllm$/);
  const path = await download.path();
  const file = readFileSync(path);

  // The file is this app's backup, holds her chat and the picture's own bytes, and nothing of the setup.
  expect(file.subarray(0, 17).toString('latin1')).toBe('kid-llm backup 2\n');
  expect(file.includes(Buffer.from('חתול על סקייטבורד'))).toBe(true);
  expect(file.includes(Buffer.from(PICTURE))).toBe(true);
  expect(file.includes(Buffer.from('not-a-real-key'))).toBe(false);
  expect(file.includes(Buffer.from('2468'))).toBe(false);
  expect(file.includes(Buffer.from('נועה'))).toBe(false);

  await page.getByRole('button', { name: 'מחיקת כל השיחות' }).tap();
  await page.getByRole('button', { name: 'כן, למחוק הכול' }).tap();
  await expect(page.getByText('כל השיחות נמחקו מהאייפון.')).toBeVisible();
  expect((await onPhone(page)).chats).toBe(0);

  await page.getByLabel('קובץ גיבוי לייבוא').setInputFiles(path);
  await expect(page.getByText('נוספה שיחה אחת, שלה.')).toBeVisible();
  expect(await onPhone(page)).toEqual({ chats: 1, picture: PICTURE });

  // A second import of the same file changes nothing.
  await page.getByLabel('קובץ גיבוי לייבוא').setInputFiles(path);
  await expect(page.getByText('לא נוספו שיחות. שיחה אחת כבר הייתה באייפון ולא שונתה.')).toBeVisible();
  expect((await onPhone(page)).chats).toBe(1);

  // A file that is no backup is refused, and the settings were never touched by any of it.
  await page.getByLabel('קובץ גיבוי לייבוא').setInputFiles({ name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from('{"apiKey":"other"}') });
  await expect(page.getByText('זה לא קובץ גיבוי של האפליקציה. שום דבר לא יובא.')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('kid-llm.key.venice'))).toBe('not-a-real-key');
});
