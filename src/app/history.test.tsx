import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AiError, type ChatResult } from '../ai/providers';
import type { ChatRequest } from '../ai/send';
import type { Chat } from '../core/chat';
import { NOT_SAVED_MESSAGE } from '../core/kidMessages';
import type { ChatStore } from '../storage/chatStore';
import { fakeParent } from '../test/fakeParent';
import { memoryStore } from '../test/memoryStore';
import { App } from './App';
import type { Services } from './useChat';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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
    generateImage: () => Promise.reject(new Error('no drawing in this test')),
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

  it('does not rename a chat while its answer is still being written', async () => {
    const store = memoryStore();
    openApp(store, hangs);
    await say('שלום');
    await screen.findByText('חצי תשובה');
    const list = await openList();
    await userEvent.click(await list.findByRole('button', { name: 'אפשרויות לשיחה: שלום' }));
    await userEvent.click(list.getByRole('button', { name: 'שינוי שם' }));
    await userEvent.clear(list.getByLabelText('שם השיחה'));
    await userEvent.type(list.getByLabelText('שם השיחה'), 'שם אחר');
    await userEvent.click(list.getByRole('button', { name: 'שמירת השם' }));
    expect(await list.findByText('השם לא נשמר.')).toBeInTheDocument();
    expect([...store.chats.values()][0].title).toBe('שלום');
    expect(title()).toBe('שלום');
  });

  it('keeps the screen behind the list out of reach, and gives the focus back when it closes', async () => {
    openApp(memoryStore());
    const menu = screen.getByRole('button', { name: 'השיחות שלי' });
    const list = await openList();
    const dialog = screen.getByRole('dialog', { name: 'השיחות שלי' });
    expect(screen.getByLabelText('הודעה').closest('[inert]')).not.toBeNull();
    expect(dialog.closest('[inert]')).toBeNull();
    expect(dialog).toHaveFocus();
    await userEvent.click(list.getByRole('button', { name: 'סגירת הרשימה' }));
    expect(screen.getByLabelText('הודעה').closest('[inert]')).toBeNull();
    expect(menu).toHaveFocus();
  });

  it('says "not saved" only on the chat whose save failed', async () => {
    const store = memoryStore([savedChat('old', 'שיחה ישנה', NOW - DAY)]);
    // The phone refuses to save any new chat.
    store.save = () => Promise.reject(new Error('full'));
    openApp(store);
    await say('שלום');
    expect(await screen.findByText(NOT_SAVED_MESSAGE)).toBeInTheDocument();
    const list = await openList();
    await userEvent.click(await list.findByRole('button', { name: 'שיחה ישנה' }));
    await waitFor(() => expect(title()).toBe('שיחה ישנה'));
    expect(screen.queryByText(NOT_SAVED_MESSAGE)).not.toBeInTheDocument();
  });

  it('gives her no way to delete a chat: the options hold only the rename', async () => {
    const store = memoryStore([savedChat('a', 'למה השמיים כחולים?', NOW - DAY), savedChat('b', 'שברים פשוטים', NOW - HOUR)]);
    openApp(store);
    const list = await openList();
    await userEvent.click(await list.findByRole('button', { name: 'אפשרויות לשיחה: שברים פשוטים' }));
    expect(list.getByRole('button', { name: 'שינוי שם' })).toBeInTheDocument();
    expect(list.queryByRole('button', { name: /מחיקה|למחוק/ })).not.toBeInTheDocument();
    expect(list.queryByText(/מחיקה|למחוק/)).not.toBeInTheDocument();
    expect([...store.chats.keys()]).toEqual(['a', 'b']);
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
