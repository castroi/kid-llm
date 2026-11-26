// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Attachment } from '../core/attachment';
import type { Chat, StoredMessage } from '../core/chat';
import { KEEP_FILES_MS } from '../core/trim';
import { memoryStore } from '../test/memoryStore';
import { MAX_PICTURES_PER_RUN, TRIM_RUN_KEY, trimOldFiles } from './trimFiles';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const OLD = NOW - KEEP_FILES_MS - DAY;

const photo = (): Attachment => {
  const bytes = new Uint8Array(1000);
  bytes.set([0xff, 0xd8, 0xff]);
  return { kind: 'image', bytes: bytes.buffer, name: 'הכיתה.jpg' };
};
const pdf = (): Attachment => ({ kind: 'pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]).buffer, name: 'דף.pdf' });
const SMALL = new Uint8Array([0xff, 0xd8, 0xff, 7]).buffer;

function message(id: string, at: number, attachments?: Attachment[]): StoredMessage {
  return { id, role: 'user', text: 'מה כתוב?', at, mode: 'chat', ...(attachments ? { attachments } : {}) };
}

/** A chat with an old message of files, and a newest one with a file that is never trimmed. */
function chatWith(id: string, old: Attachment[]): Chat {
  return { id, title: id, mode: 'chat', createdAt: 0, updatedAt: NOW, messages: [message(`${id}-old`, OLD, old), message(`${id}-new`, NOW, [pdf()])] };
}

const never = () => false;

function memory(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  return { entries, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => void entries.set(key, value) };
}

function services(store = memoryStore(), storage = memory()) {
  const thumbnail = vi.fn(async () => SMALL);
  return { store, storage, thumbnail, now: () => NOW, pause: async () => undefined };
}

describe('the cleanup of old files', () => {
  it('trims every chat but the one on the screen, and notes that it ran', async () => {
    const store = memoryStore([chatWith('a', [photo(), pdf()]), chatWith('shown', [photo()])]);
    const deps = services(store);
    expect(await trimOldFiles(deps, (id) => id === 'shown')).toBe(1);
    expect(store.chats.get('a')?.messages[0].attachments).toEqual([
      { kind: 'image', bytes: SMALL, name: '', trimmed: true },
      { kind: 'pdf', bytes: new ArrayBuffer(0), name: '', trimmed: true },
    ]);
    // Her newest message with files, and the chat on the screen, are as they were.
    expect(store.chats.get('a')?.messages[1].attachments).toEqual([pdf()]);
    expect(store.chats.get('shown')?.messages[0].attachments).toEqual([photo()]);
    expect(deps.storage.entries.get(TRIM_RUN_KEY)).toBe(String(NOW));
  });

  it('runs at most once a day, and again when the clock went back', async () => {
    const store = memoryStore([chatWith('a', [pdf()])]);
    const ranToday = services(store, memory({ [TRIM_RUN_KEY]: String(NOW - DAY / 2) }));
    expect(await trimOldFiles(ranToday, never)).toBe(0);
    expect(store.chats.get('a')?.messages[0].attachments?.[0].trimmed).toBeUndefined();

    const clockBack = services(store, memory({ [TRIM_RUN_KEY]: String(NOW + 30 * DAY) }));
    expect(await trimOldFiles(clockBack, never)).toBe(1);
  });

  it('makes no more than its share of small copies in one run, and picks up the rest next time', async () => {
    const many = Array.from({ length: 6 }, (_, i) => chatWith(`c${i}`, [photo(), photo(), photo(), photo(), photo()]));
    const store = memoryStore(many);
    const first = services(store);
    await trimOldFiles(first, never);
    expect(first.thumbnail).toHaveBeenCalledTimes(MAX_PICTURES_PER_RUN);
    // Not run to its end: not noted, so the next start goes on.
    expect(first.storage.entries.has(TRIM_RUN_KEY)).toBe(false);
    const second = services(store, first.storage);
    await trimOldFiles(second, never);
    expect(second.thumbnail).toHaveBeenCalledTimes(30 - MAX_PICTURES_PER_RUN);
    expect([...store.chats.values()].every((chat) => chat.messages[0].attachments?.every((a) => a.trimmed))).toBe(true);
    expect(second.storage.entries.get(TRIM_RUN_KEY)).toBe(String(NOW));
  });

  it('keeps a picture whole when no small copy could be made, and trims it next time', async () => {
    const store = memoryStore([chatWith('a', [photo(), pdf()])]);
    const deps = services(store);
    deps.thumbnail.mockRejectedValueOnce(new Error('cannot draw'));
    await trimOldFiles(deps, never);
    expect(store.chats.get('a')?.messages[0].attachments?.map((a) => a.trimmed ?? false)).toEqual([false, true]);
    await trimOldFiles(services(store), never);
    expect(store.chats.get('a')?.messages[0].attachments?.[0].trimmed).toBe(true);
  });

  it('never loses what she wrote while a small copy was being made', async () => {
    const store = memoryStore([chatWith('a', [photo()])]);
    const deps = services(store);
    deps.thumbnail.mockImplementationOnce(async () => {
      // She opens the chat and writes, while the picture is being drawn.
      const chat = store.chats.get('a')!;
      await store.save({ ...chat, messages: [...chat.messages, message('a-later', NOW, undefined)] });
      return SMALL;
    });
    await trimOldFiles(deps, never);
    const kept = store.chats.get('a')!;
    expect(kept.messages.map((m) => m.id)).toEqual(['a-old', 'a-new', 'a-later']);
    expect(kept.messages[0].attachments?.[0].trimmed).toBe(true);
  });

  it('leaves a chat she opened while its pictures were being made small for the next run', async () => {
    const store = memoryStore([chatWith('a', [photo(), pdf()])]);
    const deps = services(store);
    let opened = false;
    deps.thumbnail.mockImplementationOnce(async () => {
      opened = true;
      return SMALL;
    });
    await trimOldFiles(deps, (id) => opened && id === 'a');
    expect(store.chats.get('a')?.messages[0].attachments?.some((a) => a.trimmed)).toBe(false);
  });

  it('counts age only up to the newest use of the app: a clock set ahead trims nothing early', async () => {
    const recent = { ...chatWith('a', [photo()]), messages: [message('a-old', NOW - 3 * DAY, [photo()]), message('a-new', NOW, [pdf()])] };
    const store = memoryStore([recent]);
    const ahead = { ...services(store), now: () => NOW + 60 * DAY };
    expect(await trimOldFiles(ahead, never)).toBe(0);
    expect(store.chats.get('a')?.messages[0].attachments?.[0].trimmed).toBeUndefined();
  });

  it('stops quietly when the phone refuses, and tries again next time', async () => {
    const store = memoryStore([chatWith('a', [pdf()])]);
    store.edit = () => Promise.reject(new DOMException('full', 'QuotaExceededError'));
    const deps = services(store);
    await expect(trimOldFiles(deps, never)).resolves.toBe(0);
    expect(deps.storage.entries.has(TRIM_RUN_KEY)).toBe(false);
  });
});
