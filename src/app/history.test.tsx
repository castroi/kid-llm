import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AiError, type ChatResult } from '../ai/providers';
import type { ChatRequest } from '../ai/send';
import type { Chat } from '../core/chat';
import type { ChatStore } from '../storage/chatStore';
import { fakeParent } from '../test/fakeParent';
import { App } from './App';
import type { Services } from './useChat';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A phone's chat storage in memory. Like the real one, changes take effect in the order they were asked for. */
function memoryStore(initial: Chat[] = []): ChatStore & { chats: Map<string, Chat> } {
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
    remove: (id) => {
      chats.delete(id);
      return Promise.resolve();
    },
    clear: () => {
      chats.clear();
      return Promise.resolve();
    },
    close: () => undefined,
  };
}

function savedChat(id: string, title: string, updatedAt: number, mode: Chat['mode'] = 'chat'): Chat {
  return {
    id,
    title,
    mode,
    createdAt: updatedAt,
    updatedAt,
    messages: [
      { id: `${id}-q`, role: 'user', text: title, at: updatedAt, mode },
      { id: `${id}-a`, role: 'assistant', text: `תשובה על ${title}`, at: updatedAt, mode },
    ],
  };
}

type Send = (request: ChatRequest) => Promise<ChatResult>;

const answersNow: Send = async (request) => {
  request.onDelta('היי!');
  return { text: 'היי!', finishReason: 'stop' };
};

/** Writes half an answer and keeps the call open until it is stopped. */
const hangs: Send = (request) =>
  new Promise((_, reject) => {
    request.onDelta('חצי תשובה');
    request.signal?.addEventListener('abort', () => reject(new AiError('cancelled')));
  });

function openApp(store: ChatStore | null, send: Send = answersNow) {
  let id = 0;
  const services: Services = {
    store,
    loadSettings: () => ({ provider: 'venice', models: { chat: 'm', search: '', math: 'm', draw: '' }, systemPrompt: '', childName: '', dailyLimit: null }),
    loadApiKey: () => 'sk-test',
    sendChat: send,
    sentToday: () => 0,
    countMessage: () => true,
    now: () => NOW + id,
    newId: () => `id-${++id}`,
    copyText: async () => undefined,
  };
  render(<App services={services} parent={fakeParent().parent} />);
}

async function openList() {
  await userEvent.click(screen.getByRole('button', { name: 'השיחות שלי' }));
  return within(await screen.findByRole('dialog', { name: 'השיחות שלי' }));
}

async function say(text: string) {
  await userEvent.type(screen.getByLabelText('הודעה'), text);
  await userEvent.click(screen.getByRole('button', { name: 'שליחה' }));
}

const title = () => screen.getByRole('heading', { level: 1 }).textContent;

describe('the list of chats', () => {
  it('shows her saved chats under day headings, most recently used first', async () => {
    const store = memoryStore([savedChat('a', 'למה השמיים כחולים?', NOW - DAY, 'chat'), savedChat('b', 'שברים פשוטים', NOW - HOUR, 'math'), savedChat('c', 'סיפור על דרקון', NOW - 30 * DAY)]);
    openApp(store);
    const list = await openList();
    await list.findByRole('button', { name: 'שברים פשוטים' });
    expect(list.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['היום', 'אתמול', 'קודם']);
    expect(within(list.getByRole('region', { name: 'היום' })).getByRole('button', { name: 'שברים פשוטים' })).toBeInTheDocument();
    expect(within(list.getByRole('region', { name: 'קודם' })).getByRole('button', { name: 'סיפור על דרקון' })).toBeInTheDocument();
  });

  it('says so when there are no saved chats yet, and when this phone keeps nothing', async () => {
    openApp(memoryStore());
    const list = await openList();
    expect(await list.findByText('עוד אין שיחות שמורות.')).toBeInTheDocument();
    expect(list.getByText('השיחות נשמרות רק באייפון הזה.')).toBeInTheDocument();
  });

  it('does not promise saving on a phone with no storage', async () => {
    openApp(null);
    const list = await openList();
    expect(list.getByText('השיחות לא נשמרות באייפון הזה.')).toBeInTheDocument();
    expect(list.queryByText('השיחות נשמרות רק באייפון הזה.')).not.toBeInTheDocument();
  });

  it('opens a saved chat with its messages and closes the list', async () => {
    openApp(memoryStore([savedChat('b', 'שברים פשוטים', NOW - HOUR, 'math')]));
    const list = await openList();
    await userEvent.click(await list.findByRole('button', { name: 'שברים פשוטים' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(title()).toBe('שברים פשוטים');
    expect(screen.getByText('תשובה על שברים פשוטים')).toBeInTheDocument();
    // She goes on in the mode the chat was in.
    expect(screen.getByRole('button', { name: 'חשבון' })).toBeInTheDocument();
  });

  it('lists the chat she is in and marks it', async () => {
    const store = memoryStore([savedChat('old', 'שיחה ישנה', NOW - DAY)]);
    openApp(store);
    await say('שלום');
    await screen.findByText('היי!');
    const list = await openList();
    expect(await list.findByRole('button', { name: 'שלום' })).toHaveAttribute('aria-current', 'true');
    expect(list.getByRole('button', { name: 'שיחה ישנה' })).not.toHaveAttribute('aria-current');
  });

  it('starts a new chat from the list', async () => {
    openApp(memoryStore());
    await say('שלום');
    await screen.findByText('היי!');
    const list = await openList();
    await userEvent.click(list.getByRole('button', { name: 'שיחה חדשה' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('היי!')).not.toBeInTheDocument();
    expect(title()).toBe('שיחה חדשה');
  });

  it('renames a chat, in the list, on the phone and in the top bar', async () => {
    const store = memoryStore([savedChat('b', 'שברים פשוטים', NOW - HOUR)]);
    openApp(store);
    let list = await openList();
    await userEvent.click(await list.findByRole('button', { name: 'שברים פשוטים' }));
    list = await openList();
    await userEvent.click(await list.findByRole('button', { name: 'אפשרויות לשיחה: שברים פשוטים' }));
    await userEvent.click(list.getByRole('button', { name: 'שינוי שם' }));
    const field = list.getByLabelText('שם השיחה');
    expect(field).toHaveValue('שברים פשוטים');
    await userEvent.clear(field);
    await userEvent.type(field, 'שיעורי בית בחשבון');
    await userEvent.click(list.getByRole('button', { name: 'שמירת השם' }));

    expect(await list.findByRole('button', { name: 'שיעורי בית בחשבון' })).toBeInTheDocument();
    expect(store.chats.get('b')?.title).toBe('שיעורי בית בחשבון');
    // The messages are untouched.
    expect(store.chats.get('b')?.messages).toHaveLength(2);
    await userEvent.click(list.getByRole('button', { name: 'סגירת הרשימה' }));
    expect(title()).toBe('שיעורי בית בחשבון');
  });

  it('deletes a chat only after she confirms', async () => {
    const store = memoryStore([savedChat('a', 'למה השמיים כחולים?', NOW - DAY), savedChat('b', 'שברים פשוטים', NOW - HOUR)]);
    openApp(store);
    const list = await openList();
    await userEvent.click(await list.findByRole('button', { name: 'אפשרויות לשיחה: שברים פשוטים' }));
    await userEvent.click(list.getByRole('button', { name: 'מחיקה' }));
    expect(store.chats.size).toBe(2);
    await userEvent.click(list.getByRole('button', { name: 'ביטול' }));
    expect(store.chats.size).toBe(2);

    await userEvent.click(list.getByRole('button', { name: 'אפשרויות לשיחה: שברים פשוטים' }));
    await userEvent.click(list.getByRole('button', { name: 'מחיקה' }));
    await userEvent.click(list.getByRole('button', { name: 'כן, למחוק' }));
    await waitFor(() => expect(list.queryByRole('button', { name: 'שברים פשוטים' })).not.toBeInTheDocument());
    expect([...store.chats.keys()]).toEqual(['a']);
  });

  it('clears the screen when the chat she is in is deleted', async () => {
    const store = memoryStore();
    openApp(store);
    await say('שלום');
    await screen.findByText('היי!');
    const list = await openList();
    await userEvent.click(await list.findByRole('button', { name: 'אפשרויות לשיחה: שלום' }));
    await userEvent.click(list.getByRole('button', { name: 'מחיקה' }));
    await userEvent.click(list.getByRole('button', { name: 'כן, למחוק' }));
    await waitFor(() => expect(store.chats.size).toBe(0));
    await userEvent.click(list.getByRole('button', { name: 'סגירת הרשימה' }));
    expect(screen.queryByText('היי!')).not.toBeInTheDocument();
    expect(title()).toBe('שיחה חדשה');
  });

  it('does not bring a deleted chat back when its answer was still being written', async () => {
    const store = memoryStore();
    openApp(store, hangs);
    await say('שלום');
    await screen.findByText('חצי תשובה');
    expect(store.chats.size).toBe(1);

    const list = await openList();
    await userEvent.click(await list.findByRole('button', { name: 'אפשרויות לשיחה: שלום' }));
    await userEvent.click(list.getByRole('button', { name: 'מחיקה' }));
    await userEvent.click(list.getByRole('button', { name: 'כן, למחוק' }));
    await waitFor(() => expect(list.queryByRole('button', { name: 'שלום' })).not.toBeInTheDocument());
    // The stopped answer's last save found the chat gone and wrote nothing.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.chats.size).toBe(0);
  });

  it('keeps what was written when she leaves a chat in the middle of an answer', async () => {
    const store = memoryStore([savedChat('old', 'שיחה ישנה', NOW - DAY)]);
    openApp(store, hangs);
    await say('שלום');
    await screen.findByText('חצי תשובה');
    const list = await openList();
    await userEvent.click(await list.findByRole('button', { name: 'שיחה ישנה' }));
    await waitFor(() => expect(title()).toBe('שיחה ישנה'));
    await waitFor(() => {
      const left = [...store.chats.values()].find((chat) => chat.title === 'שלום');
      expect(left?.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'חצי תשובה', state: 'stopped' });
    });
    // And the send button is free again in the chat she moved to.
    expect(screen.getByRole('button', { name: 'שליחה' })).toBeInTheDocument();
  });

  it('says so when a chat in the list is no longer on the phone', async () => {
    const store = memoryStore([savedChat('b', 'שברים פשוטים', NOW - HOUR)]);
    openApp(store);
    const list = await openList();
    await list.findByRole('button', { name: 'שברים פשוטים' });
    store.chats.clear();
    await userEvent.click(list.getByRole('button', { name: 'שברים פשוטים' }));
    expect(await list.findByText('השיחה הזאת כבר לא באייפון.')).toBeInTheDocument();
    await waitFor(() => expect(list.queryByRole('button', { name: 'שברים פשוטים' })).not.toBeInTheDocument());
  });

  it("shows a chat's name as plain text, whatever it holds", async () => {
    const nasty = '<img src=x onerror=alert(1)>';
    openApp(memoryStore([savedChat('x', nasty, NOW - HOUR)]));
    const list = await openList();
    expect(await list.findByRole('button', { name: nasty })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('closes with Escape and with a tap outside', async () => {
    openApp(memoryStore());
    await openList();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const list = await openList();
    await userEvent.click(list.getByRole('button', { name: 'סגירת הרשימה' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
