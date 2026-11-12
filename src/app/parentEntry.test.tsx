import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AiError, type ChatResult } from '../ai/providers';
import type { ChatRequest } from '../ai/send';
import { SETUP_MESSAGE } from '../core/kidMessages';
import type { ChatStore } from '../storage/chatStore';
import { fakeParent } from '../test/fakeParent';
import { memoryStore } from '../test/memoryStore';
import { App } from './App';
import type { Services } from './useChat';

/** The app on a phone nobody has set up, with the chat and the parent area sharing one storage. */
function openApp(options: { store?: ChatStore; send?: (request: ChatRequest) => Promise<ChatResult> } = {}) {
  const { parent, phone } = fakeParent();
  const store = options.store ?? null;
  // "Delete all" on a phone with storage really empties it, as the real one does.
  if (store) parent.deleteAllChats = () => store.clear();
  const requests: ChatRequest[] = [];
  let id = 0;
  const services: Services = {
    store,
    loadSettings: () => phone.settings,
    loadApiKey: () => phone.apiKey,
    sendChat: async (request) => {
      requests.push(request);
      if (options.send) return options.send(request);
      request.onDelta('היי!');
      return { text: 'היי!', finishReason: 'stop' };
    },
    prepareAttachment: () => Promise.reject(new Error('no files in this test')),
    generateImage: () => Promise.reject(new Error('no drawing in this test')),
    sentToday: () => phone.sent,
    countMessage: () => {
      phone.sent += 1;
      return true;
    },
    now: () => 1_700_000_000_000 + id,
    newId: () => `id-${++id}`,
    copyText: async () => undefined,
  };
  render(<App services={services} parent={parent} />);
  return { phone, requests };
}

/** The way in: the list of chats, then the button at its bottom. */
async function openParentArea() {
  await userEvent.click(screen.getByRole('button', { name: 'השיחות שלי' }));
  await userEvent.click(screen.getByRole('button', { name: 'אזור הורים' }));
}

describe('the way into the parent area', () => {
  it('opens from the bottom of the list of chats and asks for a code first', async () => {
    openApp();
    await openParentArea();
    expect(screen.getByRole('heading', { name: 'אזור הורים' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'בחירת קוד הורים' })).toBeInTheDocument();
    // The chat is not on the screen while the parent area is.
    expect(screen.queryByLabelText('הודעה')).not.toBeInTheDocument();
  });

  it('lets her chat as soon as a parent has set the key and the model, with no reload', async () => {
    const { phone, requests } = openApp();
    expect(screen.getByText(SETUP_MESSAGE)).toBeInTheDocument();

    await openParentArea();
    await userEvent.type(screen.getByLabelText('קוד חדש (4 עד 8 ספרות)'), '2468');
    await userEvent.type(screen.getByLabelText('שוב, לאימות'), '2468');
    await userEvent.click(screen.getByRole('button', { name: 'שמירת הקוד' }));
    await userEvent.type(await screen.findByLabelText('מפתח API'), 'sk-parent');
    await userEvent.type(screen.getByLabelText('מודל למצב "שיחה"'), 'kid-model');
    await userEvent.type(screen.getByLabelText('שם הילדה'), 'נועה');
    await userEvent.click(screen.getByRole('button', { name: 'שמירה' }));
    await userEvent.click(screen.getByRole('button', { name: 'סיום' }));

    expect(screen.queryByText(SETUP_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'היי נועה, על מה נדבר היום?' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('הודעה'), 'שלום');
    await userEvent.click(screen.getByRole('button', { name: 'שליחה' }));
    expect(await screen.findByText('היי!')).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe('kid-model');
    expect(requests[0].apiKey).toBe('sk-parent');
    expect(phone.pin).toBe('2468');
  });

  it('asks for the code again every time it is opened', async () => {
    const { phone } = openApp();
    phone.pin = '2468';
    await openParentArea();
    await userEvent.type(screen.getByLabelText('קוד הורים'), '2468');
    await userEvent.click(screen.getByRole('button', { name: 'כניסה' }));
    await screen.findByLabelText('מפתח API');
    await userEvent.click(screen.getByRole('button', { name: 'סיום' }));

    await openParentArea();
    expect(screen.getByLabelText('קוד הורים')).toBeInTheDocument();
    expect(screen.queryByLabelText('מפתח API')).not.toBeInTheDocument();
  });

  it('starts a fresh chat on the screen after the parent deleted every chat', async () => {
    const { phone } = openApp();
    phone.pin = '2468';
    phone.apiKey = 'sk-parent';
    phone.settings = { ...phone.settings, models: { ...phone.settings.models, chat: 'kid-model' } };
    // The screen read the setup before the phone was set up; going through the parent area reads it again.
    await openParentArea();
    await userEvent.click(screen.getByRole('button', { name: 'סיום' }));
    await userEvent.type(screen.getByLabelText('הודעה'), 'שלום');
    await userEvent.click(screen.getByRole('button', { name: 'שליחה' }));
    expect(await screen.findByText('היי!')).toBeInTheDocument();

    await openParentArea();
    await userEvent.type(screen.getByLabelText('קוד הורים'), '2468');
    await userEvent.click(screen.getByRole('button', { name: 'כניסה' }));
    await userEvent.click(await screen.findByRole('button', { name: 'מחיקת כל השיחות' }));
    await userEvent.click(screen.getByRole('button', { name: 'כן, למחוק הכול' }));
    await screen.findByText('כל השיחות נמחקו מהאייפון.');
    await userEvent.click(screen.getByRole('button', { name: 'סיום' }));

    expect(screen.queryByText('היי!')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /על מה נדבר היום/ })).toBeInTheDocument();
    expect(phone.chatsDeleted).toBe(1);
  });

  it('does not bring a chat back after "delete all" when its answer was still being written', async () => {
    const store = memoryStore();
    // Writes half an answer and keeps the call open until it is stopped.
    const hangs = (request: ChatRequest) =>
      new Promise<ChatResult>((_, reject) => {
        request.onDelta('חצי תשובה');
        request.signal?.addEventListener('abort', () => reject(new AiError('cancelled')));
      });
    const { phone } = openApp({ store, send: hangs });
    phone.pin = '2468';
    phone.apiKey = 'sk-parent';
    phone.settings = { ...phone.settings, models: { ...phone.settings.models, chat: 'kid-model' } };
    await openParentArea();
    await userEvent.click(screen.getByRole('button', { name: 'סיום' }));
    await userEvent.type(screen.getByLabelText('הודעה'), 'שלום');
    await userEvent.click(screen.getByRole('button', { name: 'שליחה' }));
    await screen.findByText('חצי תשובה');
    expect(store.chats.size).toBe(1);

    await openParentArea();
    await userEvent.type(screen.getByLabelText('קוד הורים'), '2468');
    await userEvent.click(screen.getByRole('button', { name: 'כניסה' }));
    await userEvent.click(await screen.findByRole('button', { name: 'מחיקת כל השיחות' }));
    await userEvent.click(screen.getByRole('button', { name: 'כן, למחוק הכול' }));
    await screen.findByText('כל השיחות נמחקו מהאייפון.');
    // The stopped answer's last save found the chat gone and wrote nothing.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.chats.size).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: 'סיום' }));
    expect(screen.queryByText('חצי תשובה')).not.toBeInTheDocument();
  });
});
