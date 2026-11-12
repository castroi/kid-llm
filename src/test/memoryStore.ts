import type { Chat } from '../core/chat';
import type { ChatStore } from '../storage/chatStore';

/** A phone's chat storage in memory. Like the real one, changes take effect in the order they were asked for. */
export function memoryStore(initial: Chat[] = []): ChatStore & { chats: Map<string, Chat> } {
  const chats = new Map(initial.map((chat) => [chat.id, chat]));
  return {
    chats,
    list: async () =>
      [...chats.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ id, title, mode, createdAt, updatedAt }) => ({ id, title, mode, createdAt, updatedAt })),
    get: (id) => Promise.resolve(chats.get(id)),
    all: async () => [...chats.values()],
    save: (chat) => {
      chats.set(chat.id, chat);
      return Promise.resolve();
    },
    update: (chat) => {
      const there = chats.has(chat.id);
      if (there) chats.set(chat.id, chat);
      return Promise.resolve(there);
    },
    rename: (id, title) => {
      const chat = chats.get(id);
      if (chat) chats.set(id, { ...chat, title });
      return Promise.resolve(chat !== undefined);
    },
    clear: () => {
      chats.clear();
      return Promise.resolve();
    },
    close: () => undefined,
  };
}
