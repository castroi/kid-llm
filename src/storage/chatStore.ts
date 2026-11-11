import { sanitizeChat, type Chat, type ChatSummary } from '../core/chat';

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
  /**
   * Replaces the chat only if it is still on the phone, and says whether it was. For the
   * end of an answer: if she (or a parent) deleted the chat meanwhile, it must not come back.
   */
  update(chat: Chat): Promise<boolean>;
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
  const failed = () => tx.error ?? new DOMException('The change was not saved', 'AbortError');
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(failed());
    tx.onabort = () => reject(failed());
  });
}

/** How long opening may take; a blocked open would otherwise wait for ever. */
export const OPEN_TIMEOUT_MS = 5_000;

function openDb(factory: IDBFactory, timeoutMs: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(DB_NAME, DB_VERSION);
    // Once given up on, a connection that still arrives is closed, not left open with nobody holding it.
    let gaveUp = false;
    const timer = setTimeout(() => {
      gaveUp = true;
      reject(new DOMException('Opening the storage took too long', 'TimeoutError'));
    }, timeoutMs);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(CHATS, { keyPath: 'id' });
    };
    // Another open tab holds an older version; it has to close first.
    open.onblocked = () => {
      clearTimeout(timer);
      gaveUp = true;
      reject(new DOMException('The storage is in use by another tab', 'InvalidStateError'));
    };
    open.onerror = () => {
      clearTimeout(timer);
      reject(open.error);
    };
    open.onsuccess = () => {
      clearTimeout(timer);
      const db = open.result;
      if (gaveUp) {
        db.close();
        return;
      }
      // A newer version of the app wants to upgrade: step aside instead of blocking it.
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

function summary({ id, title, mode, createdAt, updatedAt }: Chat): ChatSummary {
  return { id, title, mode, createdAt, updatedAt };
}

/** Opens (and on first use creates) the chat store. Rejects when the browser has no usable storage. */
export async function openChatStore(factory: IDBFactory = indexedDB, timeoutMs: number = OPEN_TIMEOUT_MS): Promise<ChatStore> {
  const db = await openDb(factory, timeoutMs);

  // `async`, so a closed database gives a rejected promise, never a thrown error.
  const read = async <T>(work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => result(work(db.transaction(CHATS, 'readonly').objectStore(CHATS)));
  // Resolves only once the change is really written, not just asked for.
  const write = async (work: (store: IDBObjectStore) => void): Promise<void> => {
    const tx = db.transaction(CHATS, 'readwrite');
    const done = finished(tx);
    work(tx.objectStore(CHATS));
    await done;
  };
  // What is read back is checked like anything from outside: a damaged or restored record can't break a screen or a call.
  const usable = (records: unknown[]): Chat[] => records.map(sanitizeChat).filter((chat): chat is Chat => chat !== null);

  const all = async () => usable(await read<unknown[]>((store) => store.getAll()));
  return {
    all,
    async list() {
      return (await all()).map(summary).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async get(id) {
      return sanitizeChat(await read<unknown>((store) => store.get(id))) ?? undefined;
    },
    save: (chat) => write((store) => store.put(chat)),
    async update(chat) {
      let found = false;
      // The check and the write share one transaction, so a delete can't slip in between.
      await write((store) => {
        const existing = store.getKey(chat.id);
        existing.onsuccess = () => {
          found = existing.result !== undefined;
          if (found) store.put(chat);
        };
      });
      return found;
    },
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
