// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupError, backupHead, encodeChat } from '../core/backup';
import { newChat, withMessage, type Chat } from '../core/chat';
import { memoryStore } from '../test/memoryStore';
import { backupName, exportChats, handOver, importChats, type Backup } from './backup';

const WEBP = new Uint8Array([82, 73, 70, 70, 0, 255, 7, 9]);
const NOW = Date.parse('2026-11-16T10:00:00+02:00');

function chat(id: string, at: number, text = 'היי'): Chat {
  return withMessage(newChat('chat', at, id), { id: `${id}-1`, role: 'user', text, at, mode: 'chat' });
}

function drawing(id: string): Chat {
  return {
    ...chat(id, 100, 'חתול על סקייטבורד'),
    mode: 'draw',
    messages: [
      { id: 'q', role: 'user', text: 'חתול על סקייטבורד', at: 100, mode: 'draw' },
      { id: 'a', role: 'assistant', text: '', at: 101, mode: 'draw', image: { type: 'image/webp', bytes: WEBP.slice().buffer } },
    ],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('exporting the chats', () => {
  it('puts every chat, hers and a parent\'s own, with its pictures into one file that imports back the same', async () => {
    const chats = [chat('c1', 5), drawing('c2'), { ...chat('c3', 7), parentUse: true as const }];
    const backup = await exportChats(memoryStore(chats), NOW);
    expect(backup.chats).toBe(3);
    expect(backup.file.name).toBe('kid-llm-backup-2026-11-16.kidllm');

    const phone = memoryStore();
    expect(await importChats(phone, backup.file)).toEqual({ added: 3, kept: 0, unreadable: 0, ended: 'whole' });
    expect(phone.chats.get('c1')).toEqual(chats[0]);
    expect(phone.chats.get('c3')).toEqual(chats[2]);
    expect(new Uint8Array(phone.chats.get('c2')!.messages[1].image!.bytes)).toEqual(WEBP);
  });

  it('holds nothing but chats: a key or settings that sit in a record never reach the file', async () => {
    const store = memoryStore([{ ...chat('c1', 5), apiKey: 'sk-secret-key', pin: '13572468' } as Chat]);
    const text = await (await exportChats(store, NOW)).file.text();
    expect(text).toContain('היי');
    expect(text).not.toContain('sk-secret-key');
    expect(text).not.toContain('13572468');
  });

  it('with no chats, makes a file with none', async () => {
    const backup = await exportChats(memoryStore(), NOW);
    expect(backup.chats).toBe(0);
    expect(backup.file.size).toBe(backupHead().byteLength);
  });

  it('skips a chat that was deleted while the file was being made', async () => {
    const store = memoryStore([chat('c1', 5), chat('c2', 6)]);
    const get = store.get;
    store.get = (id) => (id === 'c2' ? Promise.resolve(undefined) : get(id));
    expect((await exportChats(store, NOW)).chats).toBe(1);
  });

  it('names the file by the day in Israel, also when the phone is set to another place', () => {
    // 23:30 in London on the 16th is already the 17th in Israel.
    expect(backupName(Date.parse('2026-11-16T23:30:00Z'))).toBe('kid-llm-backup-2026-11-17.kidllm');
  });
});

describe('importing a backup', () => {
  const fileOf = (...chats: Chat[]) => new Blob([backupHead(), ...chats.flatMap(encodeChat)]);

  it('only adds: a chat that is already on the phone is left as it is, and nothing is deleted', async () => {
    const mine = { ...chat('c1', 50, 'מה שיש באייפון'), title: 'נשאר' };
    const phone = memoryStore([mine, chat('only-here', 60)]);
    const result = await importChats(phone, fileOf(chat('c1', 999, 'מה שיש בקובץ'), chat('c2', 5)));
    expect(result).toEqual({ added: 1, kept: 1, unreadable: 0, ended: 'whole' });
    expect(phone.chats.get('c1')).toEqual(mine);
    expect([...phone.chats.keys()].sort()).toEqual(['c1', 'c2', 'only-here']);
  });

  it('refuses a file that is not a backup, and adds nothing', async () => {
    const phone = memoryStore();
    await expect(importChats(phone, new Blob(['{"chats":[]}']))).rejects.toBeInstanceOf(BackupError);
    expect(phone.chats.size).toBe(0);
  });

  it('says so when the file is cut short, and keeps what came before the cut', async () => {
    const whole = fileOf(chat('c1', 1), chat('c2', 2));
    const phone = memoryStore();
    expect(await importChats(phone, whole.slice(0, whole.size - 5))).toEqual({ added: 1, kept: 0, unreadable: 0, ended: 'cut' });
    expect([...phone.chats.keys()]).toEqual(['c1']);
  });

  it('counts records that are not chats', async () => {
    const junk = new Uint8Array([0, 0, 0, 4, 110, 117, 108, 108]); // the text "null"
    const result = await importChats(memoryStore(), new Blob([backupHead(), junk, ...encodeChat(chat('c1', 1))]));
    expect(result).toEqual({ added: 1, kept: 0, unreadable: 1, ended: 'whole' });
  });

  it('stops when the phone refuses to save, and says how far it got', async () => {
    const phone = memoryStore();
    const add = phone.add;
    phone.add = (incoming) => (incoming.id === 'c2' ? Promise.reject(new DOMException('full', 'QuotaExceededError')) : add(incoming));
    expect(await importChats(phone, fileOf(chat('c1', 1), chat('c2', 2), chat('c3', 3)))).toEqual({ added: 1, kept: 0, unreadable: 0, ended: 'not-saved' });
    expect([...phone.chats.keys()]).toEqual(['c1']);
  });
});

describe('handing the backup over', () => {
  const backup: Backup = { file: new File(['kid-llm backup 1\n'], 'kid-llm-backup-2026-11-16.kidllm'), chats: 0 };
  /** A page whose links can be watched. */
  function page() {
    const link = { href: '', download: '', click: vi.fn() };
    return { link, page: { createElement: () => link } as unknown as Document };
  }

  it('opens the share sheet with the file where the phone shares files', async () => {
    const share = vi.fn(async () => undefined);
    const canShare = vi.fn(() => true);
    const { link, page: doc } = page();
    expect(await handOver(backup, { canShare, share }, doc)).toBe('shared');
    expect(share).toHaveBeenCalledWith({ files: [backup.file] });
    expect(canShare).toHaveBeenCalledWith({ files: [backup.file] });
    expect(link.click).not.toHaveBeenCalled();
  });

  it('a closed share sheet is a cancel; any other refusal is a failure; neither downloads', async () => {
    const { link, page: doc } = page();
    const closed = { canShare: () => true, share: () => Promise.reject(new DOMException('closed', 'AbortError')) };
    const refused = { canShare: () => true, share: () => Promise.reject(new DOMException('no', 'NotAllowedError')) };
    expect(await handOver(backup, closed, doc)).toBe('cancelled');
    expect(await handOver(backup, refused, doc)).toBe('failed');
    expect(link.click).not.toHaveBeenCalled();
  });

  it('downloads the file where files can not be shared', async () => {
    vi.useFakeTimers();
    const made = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:backup');
    const freed = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const noSharing = { canShare: undefined, share: undefined } as unknown as Pick<Navigator, 'canShare' | 'share'>;
    const noFiles = { canShare: () => false, share: vi.fn() };
    for (const nav of [noSharing, noFiles]) {
      const { link, page: doc } = page();
      expect(await handOver(backup, nav, doc)).toBe('downloaded');
      expect(link).toMatchObject({ href: 'blob:backup', download: 'kid-llm-backup-2026-11-16.kidllm' });
      expect(link.click).toHaveBeenCalledTimes(1);
    }
    expect(noFiles.share).not.toHaveBeenCalled();
    expect(made).toHaveBeenCalledWith(backup.file);
    // The address is let go once the browser had time to start saving.
    expect(freed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(freed).toHaveBeenCalledTimes(2);
  });
});
