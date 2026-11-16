import { BackupError, backupHead, encodeChat, readBackup, type BackupSource, type ImportResult } from '../core/backup';
import type { ChatStore } from './chatStore';

/** A backup that is ready to leave the phone. */
export interface Backup {
  /** Every chat with its pictures and files. Never the key, the parent's code or the settings. */
  file: File;
  /** How many chats are in it. */
  chats: number;
}

const DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' });

/** "kid-llm-backup-2026-11-16.kidllm": the day it was made (Israel time) and nothing of hers. */
export function backupName(now: number): string {
  const parts = Object.fromEntries(DAY.formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  return `kid-llm-backup-${parts.year}-${parts.month}-${parts.day}.kidllm`;
}

/**
 * Every chat on the phone (hers and a parent's own, with pictures and files) as one file.
 * Read from the phone one chat at a time; the file itself is held whole in memory until it is
 * handed over. Rejects when the chats can't be read.
 */
export async function exportChats(store: ChatStore, now: number): Promise<Backup> {
  const parts: BlobPart[] = [backupHead()];
  let chats = 0;
  for (const { id } of await store.list()) {
    const chat = await store.get(id);
    const packed = chat ? encodeChat(chat) : [];
    if (packed.length === 0) continue;
    parts.push(new Blob(packed));
    chats += 1;
  }
  return { file: new File(parts, backupName(now), { type: 'application/octet-stream' }), chats };
}

/**
 * Adds the chats of a backup file to the phone. It only ever adds: a chat that is already
 * on the phone (the same id) is left as it is, and nothing is deleted. Every chat is checked
 * like anything from outside (`sanitizeChat`, inside `readBackup`); a file has no way to
 * carry settings, a key or a code, since only the chat store is written.
 * Throws BackupError when the file is not a backup of this app.
 */
export async function importChats(store: ChatStore, file: BackupSource): Promise<ImportResult> {
  const result: ImportResult = { added: 0, addedParent: 0, kept: 0, unreadable: 0, ended: 'whole' };
  try {
    const whole = await readBackup(file, async (chat) => {
      if (!chat) result.unreadable += 1;
      else if (await store.add(chat)) {
        result.added += 1;
        if (chat.parentUse) result.addedParent += 1;
      }
      else result.kept += 1;
    });
    if (!whole) result.ended = 'cut';
  } catch (err) {
    if (err instanceof BackupError) throw err;
    result.ended = 'not-saved';
  }
  return result;
}

/** How a backup left the phone: through the share sheet, as a download, not at all because the parent closed the sheet, or not at all because the phone refused. */
export type HandOver = 'shared' | 'downloaded' | 'cancelled' | 'failed';

/** How long a downloaded file's address is kept alive: long enough for the browser to start saving it. */
const DOWNLOAD_ADDRESS_MS = 60_000;

/**
 * Hands the backup to the parent. An app on the iPhone's home screen can't download a file,
 * so the phone's share sheet is used wherever it takes files ("Save to Files", AirDrop);
 * elsewhere the file is downloaded. Called straight from the parent's tap, with the file
 * already made: Safari opens the share sheet only then.
 */
export async function handOver(backup: Backup, nav: Pick<Navigator, 'canShare' | 'share'> = navigator, page: Document = document): Promise<HandOver> {
  const files = [backup.file];
  if (typeof nav.canShare === 'function' && nav.canShare({ files })) {
    try {
      await nav.share({ files });
      return 'shared';
    } catch (err) {
      return err instanceof DOMException && err.name === 'AbortError' ? 'cancelled' : 'failed';
    }
  }
  const address = URL.createObjectURL(backup.file);
  const link = page.createElement('a');
  link.href = address;
  link.download = backup.file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(address), DOWNLOAD_ADDRESS_MS);
  return 'downloaded';
}
