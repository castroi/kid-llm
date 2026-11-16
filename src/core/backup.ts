import { MAX_IMAGE_BYTES } from '../ai/providers';
import { MAX_DOCUMENT_BYTES, MAX_PICTURE_BYTES } from './attachment';
import { sanitizeChat, type Chat } from './chat';

/*
 * The backup file: every chat with its pictures and files, in one file a parent keeps.
 *
 *   the head line, then for each chat:
 *     4 bytes: how long the chat's text is (big-endian)
 *     the chat as JSON (UTF-8); where a picture or a file was, `bytes` holds its length
 *     the bytes of those pictures and files, in the order the JSON names them
 *
 * Pictures are written as they are, not as text, and the chats are read from the phone and
 * from a file one chat at a time. The file being made is still held whole in memory until it
 * is handed over.
 *
 * Only chats are ever in it. The API key, the parent's code and the settings are kept
 * elsewhere (src/storage/settings.ts, src/storage/pin.ts) and nothing here reads them; a
 * chat goes through `sanitizeChat` on its way in and on its way out, so no other field
 * can ride along in either direction.
 */

/** The file's first bytes: how a backup of this app, in this format, is told from any other file. */
export const BACKUP_HEAD = 'kid-llm backup 1\n';

/** The longest text of one chat that is read back. Far more than a real chat; a file that claims more is damaged. */
export const MAX_CHAT_TEXT_BYTES = 64 * 1024 * 1024;

/** The largest picture or file a chat can hold; a record that claims more is damaged. */
const MAX_FILE_BYTES = Math.max(MAX_IMAGE_BYTES, MAX_PICTURE_BYTES, MAX_DOCUMENT_BYTES);

/** The fields of a message that hold bytes, in the order they are written. */
const FILE_FIELDS = ['attachment', 'image'] as const;

function ascii(text: string): ArrayBuffer {
  const bytes = new Uint8Array(new ArrayBuffer(text.length));
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes.buffer;
}

/** The head of a backup file, as bytes. */
export const backupHead = (): ArrayBuffer => ascii(BACKUP_HEAD);

/**
 * One chat as it is written into a backup: its text first, then its pictures and files.
 * Empty when it is not a chat. Only what `sanitizeChat` keeps is written.
 */
export function encodeChat(chat: Chat): ArrayBuffer[] {
  const clean = sanitizeChat(chat);
  if (!clean) return [];
  const files: ArrayBuffer[] = [];
  const lengthOf = <T extends { bytes: ArrayBuffer }>(holder: T) => {
    files.push(holder.bytes);
    return { ...holder, bytes: holder.bytes.byteLength };
  };
  const record = {
    ...clean,
    messages: clean.messages.map(({ attachment, image, ...rest }) => ({
      ...rest,
      ...(attachment ? { attachment: lengthOf(attachment) } : {}),
      ...(image ? { image: lengthOf(image) } : {}),
    })),
  };
  const text = new TextEncoder().encode(JSON.stringify(record));
  const head = new ArrayBuffer(4 + text.byteLength);
  new DataView(head).setUint32(0, text.byteLength);
  new Uint8Array(head).set(text, 4);
  return [head, ...files];
}

/** A file as it is read back: only its size and a way to read a part of it. */
export type BackupSource = Pick<Blob, 'size' | 'slice'>;

/** The file is not a backup of this app. Says nothing about the file itself. */
export class BackupError extends Error {
  constructor() {
    super('not-a-backup');
    this.name = 'BackupError';
  }
}

/** What importing a backup file did (src/storage/backup.ts). */
export interface ImportResult {
  /** Chats that were not on the phone and are now. */
  added: number;
  /** Of those, how many are marked as a parent's own. Told apart, so a parent can notice a file that was changed. */
  addedParent: number;
  /** Chats that were already on the phone; they were left as they are. */
  kept: number;
  /** Records in the file that are not chats. */
  unreadable: number;
  /**
   * `whole`: the file was read to its end. `cut`: it is cut short or damaged from some point on.
   * `not-saved`: the phone refused to save a chat (no space, usually), and the import stopped there.
   */
  ended: 'whole' | 'cut' | 'not-saved';
}

/**
 * Reads a backup one chat at a time and hands each to `onRecord`: a chat as it may be used
 * (`sanitizeChat`, like anything from outside), or null for a record that is not a chat.
 * Resolves with whether the file was read to its end; false when it is cut short or damaged
 * from some point on (what came before that point was still handed over). Throws BackupError
 * when the file does not start like a backup, and whatever `onRecord` rejects with.
 */
export async function readBackup(file: BackupSource, onRecord: (chat: Chat | null) => Promise<void>): Promise<boolean> {
  /** The part of the file from `from`, `length` bytes long; null when the file doesn't hold it or can't be read. */
  const read = async (from: number, length: number): Promise<ArrayBuffer | null> => {
    if (from + length > file.size) return null;
    try {
      const bytes = await file.slice(from, from + length).arrayBuffer();
      return bytes.byteLength === length ? bytes : null;
    } catch {
      return null;
    }
  };

  const expected = new Uint8Array(backupHead());
  const head = await read(0, expected.length);
  if (!head || !new Uint8Array(head).every((byte, i) => byte === expected[i])) throw new BackupError();

  let at = expected.length;
  while (at < file.size) {
    const size = await read(at, 4);
    if (!size) return false;
    const length = new DataView(size).getUint32(0);
    if (length === 0 || length > MAX_CHAT_TEXT_BYTES) return false;
    const text = await read(at + 4, length);
    if (!text) return false;
    at += 4 + length;

    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(text));
    } catch {
      return false;
    }
    // The bytes that follow belong to the pictures and files the text names, in its order.
    // A length that makes no sense leaves no way to find the next chat: the reading ends there.
    const messages: unknown[] = raw && typeof raw === 'object' && Array.isArray((raw as { messages?: unknown }).messages) ? (raw as { messages: unknown[] }).messages : [];
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      for (const field of FILE_FIELDS) {
        const holder = (message as Record<string, unknown>)[field];
        if (!holder || typeof holder !== 'object') continue;
        const wanted = (holder as Record<string, unknown>).bytes;
        if (typeof wanted !== 'number' || !Number.isInteger(wanted) || wanted < 1 || wanted > MAX_FILE_BYTES) return false;
        const bytes = await read(at, wanted);
        if (!bytes) return false;
        at += wanted;
        (holder as Record<string, unknown>).bytes = bytes;
      }
    }
    await onRecord(sanitizeChat(raw));
  }
  return true;
}
