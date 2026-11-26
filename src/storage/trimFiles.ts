import { dueTrims, thumbnailKey, withTrimmed } from '../core/trim';
import type { ChatStore } from './chatStore';

/** When the last cleanup ran to its end, in milliseconds since 1970. Nothing of hers: only a time. */
export const TRIM_RUN_KEY = 'kid-llm.trimmed-at.v1';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Pictures made small in one run at most; the rest wait for the next run, so a run never holds up the phone for long. */
export const MAX_PICTURES_PER_RUN = 20;

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

export interface TrimServices {
  store: ChatStore;
  now: () => number;
  /** Makes the small copy of a picture (src/main.tsx); rejects when it can't. */
  thumbnail: (bytes: ArrayBuffer) => Promise<ArrayBuffer>;
  storage?: KeyValue;
  /** A breath between two pictures, so the screen stays smooth. */
  pause?: () => Promise<void>;
}

function lastRun(storage: KeyValue): number | null {
  try {
    const value = Number(storage.getItem(TRIM_RUN_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Trims the files that are due (src/core/trim.ts) in every chat on the phone except those `skip`
 * names, asked again before each chat (the chat on the screen, which the app holds in memory and
 * would save back whole, and every chat while an answer is being written). Age is counted up to
 * the newest use of the app, never past it: a phone clock set ahead trims nothing until she has
 * used the app at that time. Runs at
 * most once a day: a run that stops early (too many pictures, a full phone, a failure) is
 * picked up again the next time. Each chat is read, its pictures are made small one at a time,
 * and only then is it written, through `ChatStore.edit`, which checks the chat as it is at that
 * moment: what she wrote meanwhile is never lost. Resolves with how many chats were changed;
 * never rejects.
 */
export async function trimOldFiles(services: TrimServices, skip: (chatId: string) => boolean): Promise<number> {
  const storage = services.storage ?? localStorage;
  const now = services.now();
  const last = lastRun(storage);
  // Once a day; a clock that went back counts as due, so a wrong date set once can't stop it for good.
  if (last !== null && now >= last && now - last < DAY_MS) return 0;
  const pause = services.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 200)));
  let changed = 0;
  let budget = MAX_PICTURES_PER_RUN;
  try {
    const summaries = await services.store.list();
    // The newest use of the app: a clock set ahead since then can't make files look older than they are.
    const until = Math.min(now, Math.max(0, ...summaries.map((summary) => summary.updatedAt)));
    for (const { id } of summaries) {
      if (skip(id)) continue;
      const chat = await services.store.get(id);
      if (!chat) continue;
      const due = dueTrims(chat, until);
      if (due.length === 0) continue;
      const thumbnails = new Map<string, ArrayBuffer | null>();
      for (const trim of due) {
        if (trim.kind !== 'image') continue;
        if (budget === 0) break;
        budget -= 1;
        const picture = chat.messages.find((message) => message.id === trim.messageId)?.attachments?.[trim.index];
        try {
          thumbnails.set(thumbnailKey(trim), picture ? await services.thumbnail(picture.bytes) : null);
        } catch {
          // Stays whole for now; the next run tries again.
          thumbnails.set(thumbnailKey(trim), null);
        }
        await pause();
      }
      // Opened, or written to, while its pictures were being made small: left for the next run.
      if (skip(id)) continue;
      if (await services.store.edit(id, (current) => withTrimmed(current, until, thumbnails))) changed += 1;
      if (budget === 0) return changed;
    }
  } catch {
    // The phone refused (no space, storage gone): stop quietly and try again next time.
    return changed;
  }
  try {
    storage.setItem(TRIM_RUN_KEY, String(now));
  } catch {
    // Without the time it simply runs again next time.
  }
  return changed;
}
