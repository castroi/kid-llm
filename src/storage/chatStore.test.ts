// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { newChat, withMessage, type Chat } from '../core/chat';
import { openChatStore, requestPersistence } from './chatStore';

function chat(id: string, updatedAt: number, text = 'היי'): Chat {
  return withMessage(newChat('chat', updatedAt, id), { id: `${id}-1`, role: 'user', text, at: updatedAt, mode: 'chat' });
}

describe('chat store', () => {
  it('keeps a chat with its messages and gives it back as it was', async () => {
    const store = await openChatStore(new IDBFactory());
    const saved = chat('c1', 100, 'למה השמיים כחולים?');
    await store.save(saved);
    expect(await store.get('c1')).toEqual(saved);
    expect(await store.get('missing')).toBeUndefined();
  });

  it('lists chats most recently used first, without their messages', async () => {
    const store = await openChatStore(new IDBFactory());
    await store.save(chat('old', 100));
    await store.save(chat('new', 300));
    await store.save(chat('middle', 200));
    const list = await store.list();
    expect(list.map((c) => c.id)).toEqual(['new', 'middle', 'old']);
    expect(list[0]).toEqual({ id: 'new', title: 'היי', mode: 'chat', createdAt: 300, updatedAt: 300 });
    expect(list[0]).not.toHaveProperty('messages');
  });

  it('replaces a chat saved again under the same id', async () => {
    const store = await openChatStore(new IDBFactory());
    await store.save(chat('c1', 100));
    await store.save({ ...chat('c1', 100), title: 'שם חדש' });
    expect((await store.all()).map((c) => c.title)).toEqual(['שם חדש']);
  });

  it('deletes one chat, or all of them', async () => {
    const store = await openChatStore(new IDBFactory());
    await store.save(chat('a', 1));
    await store.save(chat('b', 2));
    await store.save(chat('c', 3));
    await store.remove('b');
    expect((await store.list()).map((c) => c.id)).toEqual(['c', 'a']);
    await store.clear();
    expect(await store.all()).toEqual([]);
  });

  it('still has the chats after the app is closed and opened again', async () => {
    const phone = new IDBFactory();
    const first = await openChatStore(phone);
    await first.save(chat('c1', 100));
    first.close();
    const second = await openChatStore(phone);
    expect((await second.list()).map((c) => c.id)).toEqual(['c1']);
  });

  it('fails loudly when the browser has no usable storage', async () => {
    const broken = {
      open: () => {
        const request = { error: new Error('storage is off') } as unknown as IDBOpenDBRequest;
        queueMicrotask(() => request.onerror?.(new Event('error')));
        return request;
      },
    } as unknown as IDBFactory;
    await expect(openChatStore(broken)).rejects.toThrow('storage is off');
  });
});

describe('requestPersistence', () => {
  it("asks the browser to keep the phone's data, and reports the answer", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    expect(await requestPersistence({ persist })).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    expect(await requestPersistence({ persist: () => Promise.resolve(false) })).toBe(false);
  });

  it('is simply "no" where the browser cannot be asked or refuses', async () => {
    expect(await requestPersistence(undefined)).toBe(false);
    expect(await requestPersistence({ persist: () => Promise.reject(new Error('denied')) })).toBe(false);
  });
});
