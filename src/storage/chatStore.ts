import type { Chat, ChatSummary } from '../core/chat';

/**
 * Her chats, kept in this browser's IndexedDB: on the phone only, never sent to the
 * website. Each chat is one record with its messages. The API key is NOT here
 * (src/storage/settings.ts), so a backup of the chats can never carry it.
 */
export interface ChatStore {
  /** Every chat without its messages, most recently used first. */
  list(): Promise<ChatSummary[]>;
  get(id: string): Promise<Chat | undefined>;
  /** Every chat with its messages (backup, and counting for the daily limit). */
  all(): Promise<Chat[]>;
  /** Adds the chat, or replaces the one with the same id. */
  save(chat: Chat): Promise<void>;
  remove(id: string): Promise<void>;
  /** Deletes every chat ("מחיקת כל השיחות"). */
  clear(): Promise<void>;
  close(): void;
}

export const DB_NAME = 'kid-llm';
const DB_VERSION = 1;
const CHATS = 'chats';

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function summary({ id, title, mode, createdAt, updatedAt }: Chat): ChatSummary {
  return { id, title, mode, createdAt, updatedAt };
}

/** Opens (and on first use creates) the chat store. Rejects when the browser has no usable storage. */
export async function openChatStore(factory: IDBFactory = indexedDB): Promise<ChatStore> {
  const open = factory.open(DB_NAME, DB_VERSION);
  open.onupgradeneeded = () => {
    open.result.createObjectStore(CHATS, { keyPath: 'id' });
  };
  const db = await result(open);

  const read = <T>(work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => result(work(db.transaction(CHATS, 'readonly').objectStore(CHATS)));
  // Resolves only once the change is really written, not just asked for.
  const write = async (work: (store: IDBObjectStore) => void): Promise<void> => {
    const tx = db.transaction(CHATS, 'readwrite');
    const done = finished(tx);
    work(tx.objectStore(CHATS));
    await done;
  };

  const all = () => read<Chat[]>((store) => store.getAll());
  return {
    all,
    async list() {
      return (await all()).map(summary).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    get: (id) => read<Chat | undefined>((store) => store.get(id)),
    save: (chat) => write((store) => store.put(chat)),
    remove: (id) => write((store) => store.delete(id)),
    clear: () => write((store) => store.clear()),
    close: () => db.close(),
  };
}

/**
 * Asks the browser not to delete this site's data when the phone runs low on space.
 * Safari also deletes a website's data after about a week without a visit unless the
 * app was added to the home screen; that is why the app asks to be installed.
 * Resolves with whether the data is now protected.
 */
export async function requestPersistence(storage: Pick<StorageManager, 'persist'> | undefined = navigator.storage): Promise<boolean> {
  try {
    return (await storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
