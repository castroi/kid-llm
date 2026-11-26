import type { Attachment } from './attachment';
import type { Chat } from './chat';

/*
 * What is kept of the files she attached, as they get older: whole for two weeks, then a picture
 * as a small copy (enough for a parent to see what she sent) and a document as a note of its kind
 * only. Her name for a file goes with it. The files of her newest message with files are kept whole
 * whatever their age, since they are still sent with her follow-ups. Applies to a parent's own
 * chats too. Nothing that was trimmed is ever sent to a model again (src/core/chat.ts).
 */

export const KEEP_FILES_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
export const KEEP_FILES_MS = KEEP_FILES_DAYS * DAY_MS;
/** The longest side of the small copy a picture is kept as, in pixels, and its JPEG quality. */
export const THUMBNAIL_SIDE = 640;
export const THUMBNAIL_QUALITY = 0.55;

/** One file to trim: which message, which of its files, and what kind it is. */
export interface Trim {
  messageId: string;
  index: number;
  kind: Attachment['kind'];
}

/**
 * The files of a chat that are due to be trimmed at `now`: on a message of hers sent more than
 * `KEEP_FILES_MS` ago (never one dated after `now`, since the phone's clock may be wrong), not yet
 * trimmed, and not on her newest message with files.
 */
export function dueTrims(chat: Chat, now: number): Trim[] {
  let newest = -1;
  chat.messages.forEach((message, index) => {
    if (message.role === 'user' && message.attachments && message.attachments.length > 0) newest = index;
  });
  const due: Trim[] = [];
  chat.messages.forEach((message, at) => {
    if (at === newest || message.role !== 'user' || !message.attachments) return;
    if (message.at > now || now - message.at <= KEEP_FILES_MS) return;
    message.attachments.forEach((attachment, index) => {
      if (!attachment.trimmed) due.push({ messageId: message.id, index, kind: attachment.kind });
    });
  });
  return due;
}

/** A small copy of a picture, made by the caller; null when none could be made (the picture then stays whole for now). */
export type Thumbnails = ReadonlyMap<string, ArrayBuffer | null>;
const keyOf = (trim: Pick<Trim, 'messageId' | 'index'>) => `${trim.messageId}#${trim.index}`;
export const thumbnailKey = keyOf;

/**
 * The chat with its due files trimmed, as it is now: only files that are still due (checked
 * again on this chat, which may have changed since `dueTrims` was asked), a picture only when a
 * small copy of it was made. null when nothing changed.
 */
export function withTrimmed(chat: Chat, now: number, thumbnails: Thumbnails): Chat | null {
  const due = new Set(dueTrims(chat, now).map(keyOf));
  let changed = false;
  const messages = chat.messages.map((message) => {
    if (!message.attachments) return message;
    const attachments = message.attachments.map((attachment, index): Attachment => {
      const key = keyOf({ messageId: message.id, index });
      if (!due.has(key)) return attachment;
      const marks = { trimmed: true as const, ...(attachment.refused ? { refused: true as const } : {}) };
      if (attachment.kind !== 'image') {
        changed = true;
        return { kind: attachment.kind, bytes: new ArrayBuffer(0), name: '', ...marks };
      }
      const small = thumbnails.get(key);
      if (!small) return attachment;
      changed = true;
      // A copy that came out larger than the picture (a tiny one) is no use: the picture is kept as it is, without her name.
      return { kind: 'image', bytes: small.byteLength < attachment.bytes.byteLength ? small : attachment.bytes, name: '', ...marks };
    });
    return attachments.some((attachment, index) => attachment !== message.attachments![index]) ? { ...message, attachments } : message;
  });
  return changed ? { ...chat, messages } : null;
}
