import { summaryOf, type Chat } from '../core/chat';
import type { ChatStore } from '../storage/chatStore';

/** A phone's chat storage in memory. Like the real one, changes take effect in the order they were asked for. */
export function memoryStore(initial: Chat[] = []): ChatStore & { chats: Map<string, Chat> } {
  const chats = new Map(initial.map((chat) => [chat.id, chat]));
  return {
    chats,
    list: async () =>
      [...chats.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(summaryOf),
    get: (id) => Promise.resolve(chats.get(id)),
    all: async () => [...chats.values()],
    save: (chat) => {
      chats.set(chat.id, chat);
      return Promise.resolve();
    },
    add: (chat) => {
      const free = !chats.has(chat.id);
      if (free) chats.set(chat.id, chat);
      return Promise.resolve(free);
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
    edit: (id, change) => {
      const chat = chats.get(id);
      const changed = chat ? change(chat) : null;
      if (changed) chats.set(id, changed);
      return Promise.resolve(changed !== null);
    },
    clear: () => {
      chats.clear();
      return Promise.resolve();
    },
    close: () => undefined,
  };
}
