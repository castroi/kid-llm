import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AiError, type AiErrorReason, type ChatResult, type GeneratedImage } from '../ai/providers';
import type { ChatRequest, ImageRequest } from '../ai/send';
import type { ChatStore } from '../storage/chatStore';
import type { Settings } from '../storage/settings';
import { fakeParent } from '../test/fakeParent';
import { memoryStore } from '../test/memoryStore';
import { App } from './App';
import { MAX_RESUMES, type Services } from './useChat';

/*
 * What happens to an answer when the app leaves the screen (home screen, another app, a
 * locked phone). iOS stops a web app's code and connection there, so the call fails once
 * she is back; the app then asks again by itself instead of showing her an error.
 */

const SETTINGS: Settings = {
  provider: 'venice',
  models: { chat: 'model-chat', search: 'model-search', math: '', draw: 'model-draw' },
  systemPrompt: '',
  childName: '',
  dailyLimit: null,
};

const NO_INTERNET = 'אין אינטרנט כרגע. ננסה שוב?';

/** One call to the provider, held open until the test ends it. */
interface Call {
  request: ChatRequest;
  finish: () => void;
  fail: (reason: AiErrorReason) => void;
}

/** One picture request, held open until the test ends it. */
interface Picture {
  request: ImageRequest;
  finish: () => void;
  fail: (reason: AiErrorReason) => void;
}

const PICTURE: GeneratedImage = { type: 'image/webp', bytes: new Uint8Array([82, 73, 70, 70]).buffer };

function openApp(options: { store?: ChatStore | null } = {}) {
  const calls: Call[] = [];
  const pictures: Picture[] = [];
  let sent = 0;
  let id = 0;
  // What a parent may change while she is away.
  const phone = { settings: SETTINGS, apiKey: 'sk-test' };
  const services: Services = {
    store: options.store ?? null,
    loadSettings: () => phone.settings,
    loadApiKey: () => phone.apiKey,
    sendChat: (request) =>
      new Promise<ChatResult>((resolve, reject) => {
        // Like the real call, her stop ends it.
        request.signal?.addEventListener('abort', () => reject(new AiError('cancelled')));
        calls.push({ request, finish: () => resolve({ text: 'whole', finishReason: 'stop' }), fail: (reason) => reject(new AiError(reason)) });
      }),
    prepareAttachment: () => Promise.reject(new Error('no files in this test')),
    generateImage: (request) =>
      new Promise<GeneratedImage>((resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new AiError('cancelled')));
        pictures.push({ request, finish: () => resolve(PICTURE), fail: (reason) => reject(new AiError(reason)) });
      }),
    sentToday: () => sent,
    countMessage: () => {
      sent += 1;
      return true;
    },
    now: () => 1_700_000_000_000 + id,
    newId: () => `id-${++id}`,
    copyText: async () => undefined,
  };
  render(<App services={services} parent={fakeParent().parent} />);
  return { calls, pictures, phone, sentNow: () => sent };
}

async function say(text: string) {
  await userEvent.type(screen.getByLabelText('הודעה'), text);
  await userEvent.click(screen.getByRole('button', { name: 'שליחה' }));
}

/** The provider sends a piece of the answer. */
const writes = (call: Call, piece: string) => act(async () => call.request.onDelta(piece));
const finishes = (call: Call) => act(async () => call.finish());
/** The call breaks, as the phone's cut connection does. */
const breaks = (call: Call, reason: AiErrorReason = 'network') => act(async () => call.fail(reason));

function show(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => void document.dispatchEvent(new Event('visibilitychange')));
}
const leaveApp = () => show('hidden');
const comeBack = () => show('visible');

afterEach(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

/** Lets everything already started settle, to show that nothing more happens. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

describe('an answer cut because the app left the screen', () => {
  it('is asked for again by the app when she is back, with the same messages, and she sees no error', async () => {
    const { calls, sentNow } = openApp();
    await say('למה השמיים כחולים?');
    await writes(calls[0], 'חצי תשובה');
    expect(screen.getByText('חצי תשובה')).toBeInTheDocument();

    leaveApp();
    comeBack();
    await breaks(calls[0]);

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].request.messages).toEqual(calls[0].request.messages);
    expect(calls[1].request.messages).toEqual([{ role: 'user', content: 'למה השמיים כחולים?' }]);
    expect(screen.queryByText(NO_INTERNET)).not.toBeInTheDocument();
    // The cut half gives way to the new answer.
    await waitFor(() => expect(screen.queryByText('חצי תשובה')).not.toBeInTheDocument());

    await writes(calls[1], 'תשובה שלמה');
    await finishes(calls[1]);
    expect(screen.getByText('תשובה שלמה')).toBeInTheDocument();
    expect(screen.queryByText(/התשובה נקטעה/)).not.toBeInTheDocument();
    expect(screen.queryByText(NO_INTERNET)).not.toBeInTheDocument();
    // Her message is there once, and counted once: asking again is free.
    expect(screen.getAllByText('למה השמיים כחולים?', { selector: '.bubble' })).toHaveLength(1);
    expect(sentNow()).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('waits for her to come back when the call breaks while the app is still off the screen', async () => {
    const { calls } = openApp();
    await say('שלום');
    await writes(calls[0], 'חצי');
    leaveApp();
    await breaks(calls[0]);
    await settle();
    // Nothing is sent from the background, and no error waits for her.
    expect(calls).toHaveLength(1);
    expect(screen.queryByText(NO_INTERNET)).not.toBeInTheDocument();

    comeBack();
    await waitFor(() => expect(calls).toHaveLength(2));
    await writes(calls[1], 'הנה');
    await finishes(calls[1]);
    expect(screen.getByText('הנה')).toBeInTheDocument();
  });

  it('also when it ends as a timeout, and before any piece arrived', async () => {
    const { calls, sentNow } = openApp();
    await say('שלום');
    leaveApp();
    comeBack();
    await breaks(calls[0], 'timeout');
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(screen.queryByText('זה לקח יותר מדי זמן. ננסה שוב?')).not.toBeInTheDocument();
    await writes(calls[1], 'הנה');
    await finishes(calls[1]);
    expect(screen.getByText('הנה')).toBeInTheDocument();
    expect(sentNow()).toBe(1);
  });

  it('brings the cut half back, marked as cut, when the second call brings nothing either', async () => {
    const { calls } = openApp();
    await say('שלום');
    await writes(calls[0], 'חצי תשובה');
    leaveApp();
    comeBack();
    await breaks(calls[0]);
    await waitFor(() => expect(calls).toHaveLength(2));
    // She stayed this time, so this failure is an ordinary one.
    await breaks(calls[1]);
    expect(await screen.findByText(NO_INTERNET)).toBeInTheDocument();
    expect(screen.getByText('חצי תשובה')).toBeInTheDocument();
    expect(screen.getByText(/התשובה נקטעה/)).toBeInTheDocument();
    expect(calls).toHaveLength(2);
  });

  it(`gives up after ${MAX_RESUMES} tries of its own and shows the usual "try again"`, async () => {
    const { calls, sentNow } = openApp();
    await say('שלום');
    for (let tries = 0; tries < MAX_RESUMES; tries++) {
      leaveApp();
      comeBack();
      await breaks(calls[tries]);
      await waitFor(() => expect(calls).toHaveLength(tries + 2));
      expect(screen.queryByText(NO_INTERNET)).not.toBeInTheDocument();
    }
    leaveApp();
    comeBack();
    await breaks(calls[MAX_RESUMES]);
    expect(await screen.findByText(NO_INTERNET)).toBeInTheDocument();
    await settle();
    expect(calls).toHaveLength(MAX_RESUMES + 1);
    expect(sentNow()).toBe(1);

    // Her own "try again" still works, and starts a fresh count.
    await userEvent.click(screen.getByRole('button', { name: 'ננסה שוב' }));
    await waitFor(() => expect(calls).toHaveLength(MAX_RESUMES + 2));
  });
});

describe('asking again goes with the setup as it is now', () => {
  it('uses the provider, model, instructions and key the parent set while she was away', async () => {
    const { calls, phone } = openApp();
    await say('שלום');
    expect(calls[0].request).toMatchObject({ model: 'model-chat', apiKey: 'sk-test', systemPrompt: '' });
    leaveApp();
    phone.settings = { ...SETTINGS, models: { ...SETTINGS.models, chat: 'model-new' }, systemPrompt: 'Be brief.' };
    phone.apiKey = 'sk-new';
    await breaks(calls[0]);
    comeBack();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].request).toMatchObject({ model: 'model-new', apiKey: 'sk-new', systemPrompt: 'Be brief.' });
  });

  it('does not ask again once the parent took the key away, and shows the usual notice instead', async () => {
    const { calls, phone } = openApp();
    await say('שלום');
    await writes(calls[0], 'חצי תשובה');
    leaveApp();
    phone.apiKey = '';
    await breaks(calls[0]);
    comeBack();
    expect(await screen.findByText(NO_INTERNET)).toBeInTheDocument();
    await settle();
    expect(calls).toHaveLength(1);
    // What was cut stays, marked as cut.
    expect(screen.getByText('חצי תשובה')).toBeInTheDocument();
    expect(screen.getByText(/התשובה נקטעה/)).toBeInTheDocument();
  });

  it('does not ask again once the mode has no model any more', async () => {
    const { calls, phone } = openApp();
    await say('שלום');
    leaveApp();
    phone.settings = { ...SETTINGS, models: { ...SETTINGS.models, chat: '' } };
    await breaks(calls[0], 'timeout');
    comeBack();
    // The notice is for the reason the call really ended.
    expect(await screen.findByText('זה לקח יותר מדי זמן. ננסה שוב?')).toBeInTheDocument();
    await settle();
    expect(calls).toHaveLength(1);
  });
});

describe('asking again in search mode', () => {
  it('asks again as a search, with only what she wrote in search mode', async () => {
    const { calls } = openApp();
    await say('שלום');
    await writes(calls[0], 'היי');
    await finishes(calls[0]);
    // The mode is changed from the chip next to the message box once a chat has messages.
    await userEvent.click(document.querySelector('.mode-chip') as HTMLElement);
    await userEvent.click(within(screen.getByRole('dialog', { name: 'במה להשתמש עכשיו?' })).getByRole('button', { name: /חיפוש/ }));
    await say('מי המציא את הטלפון?');
    await waitFor(() => expect(calls).toHaveLength(2));
    leaveApp();
    comeBack();
    await breaks(calls[1]);
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2].request).toMatchObject({ model: 'model-search', webSearch: true });
    expect(calls[2].request.messages).toEqual([{ role: 'user', content: 'מי המציא את הטלפון?' }]);
    expect(calls[2].request.messages).toEqual(calls[1].request.messages);
  });
});

describe('asking again in drawing mode', () => {
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  beforeAll(() => {
    // jsdom has no picture addresses of its own.
    URL.createObjectURL = vi.fn(() => 'blob:picture');
    URL.revokeObjectURL = vi.fn();
  });
  afterAll(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });
  const pickDraw = () => userEvent.click(within(screen.getByRole('group', { name: 'מצב' })).getByRole('button', { name: /ציור/ }));

  it('draws again from what she wrote for that picture only, with the drawing model, free of the count', async () => {
    const { calls, pictures, sentNow } = openApp();
    await pickDraw();
    await say('חתול על סקייטבורד');
    await waitFor(() => expect(pictures).toHaveLength(1));
    leaveApp();
    comeBack();
    await act(async () => pictures[0].fail('network'));
    await waitFor(() => expect(pictures).toHaveLength(2));
    expect(pictures[1].request).toMatchObject({ model: 'model-draw', prompt: 'חתול על סקייטבורד' });
    expect(screen.queryByText(NO_INTERNET)).not.toBeInTheDocument();
    await act(async () => pictures[1].finish());
    expect(await screen.findByRole('img', { name: 'התמונה שציירתי' })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    expect(sentNow()).toBe(1);
  });

  it('counts a paid redraw once, when its picture finally arrives after a cut', async () => {
    const { pictures, sentNow } = openApp();
    await pickDraw();
    await say('דרקון');
    await act(async () => pictures[0].finish());
    await screen.findByRole('img', { name: 'התמונה שציירתי' });
    expect(sentNow()).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'נסי שוב' }));
    await waitFor(() => expect(pictures).toHaveLength(2));
    leaveApp();
    comeBack();
    await act(async () => pictures[1].fail('timeout'));
    await waitFor(() => expect(pictures).toHaveLength(3));
    expect(pictures[2].request.prompt).toBe('דרקון');
    expect(sentNow()).toBe(1);
    await act(async () => pictures[2].finish());
    await waitFor(() => expect(sentNow()).toBe(2));
    expect(screen.getAllByRole('img', { name: 'התמונה שציירתי' })).toHaveLength(1);
  });
});

describe('when she does something herself before the app is back', () => {
  it('lets her own new message win: exactly one new call goes out', async () => {
    const { calls } = openApp();
    await say('ראשונה');
    leaveApp();
    await breaks(calls[0]);
    // Still off the screen as far as the app knows, she sends another message.
    await say('שנייה');
    await waitFor(() => expect(calls).toHaveLength(2));
    comeBack();
    await settle();
    expect(calls).toHaveLength(2);
    // The first question got no answer, so it goes along with the new one, as always.
    expect(calls[1].request.messages.at(-1)).toEqual({ role: 'user', content: 'ראשונה\n\nשנייה' });
  });

  it('lets her own "try again" win as well', async () => {
    const { calls } = openApp();
    await say('שלום');
    await writes(calls[0], 'חצי');
    leaveApp();
    await breaks(calls[0]);
    // No error is shown for a cut; the button under the cut half is the one she has.
    expect(screen.queryByText(NO_INTERNET)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'נסי שוב' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    comeBack();
    await settle();
    expect(calls).toHaveLength(2);
  });
});

describe('an answer that fails for another reason', () => {
  it('shows the error as before when she never left', async () => {
    const { calls } = openApp();
    await say('שלום');
    await writes(calls[0], 'חצי');
    await breaks(calls[0]);
    expect(await screen.findByText(NO_INTERNET)).toBeInTheDocument();
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('shows the error when the answer went on after she came back and broke later', async () => {
    const { calls } = openApp();
    await say('שלום');
    await writes(calls[0], 'חצי');
    leaveApp();
    comeBack();
    // The connection survived her short absence; what breaks it later is not her leaving.
    await writes(calls[0], ' ועוד');
    await breaks(calls[0]);
    expect(await screen.findByText(NO_INTERNET)).toBeInTheDocument();
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('does not take a piece that arrived in the background for a sign that she is back', async () => {
    const { calls } = openApp();
    await say('שלום');
    leaveApp();
    // The phone lets the app run a moment longer before it stops it.
    await writes(calls[0], 'חצי');
    await breaks(calls[0]);
    comeBack();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(screen.queryByText(NO_INTERNET)).not.toBeInTheDocument();
  });

  it('never asks again for a problem only a parent can fix, even if she left meanwhile', async () => {
    const { calls } = openApp();
    await say('שלום');
    leaveApp();
    comeBack();
    await breaks(calls[0], 'unauthorized');
    expect(await screen.findByText('משהו לא עובד. כדאי לקרוא לאבא או לאמא.')).toBeInTheDocument();
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('never asks again after her own stop, even if she left meanwhile', async () => {
    const { calls } = openApp();
    await say('שלום');
    await writes(calls[0], 'חצי');
    leaveApp();
    comeBack();
    await userEvent.click(screen.getByRole('button', { name: 'עצירה' }));
    expect(await screen.findByText(/עצרת כאן/)).toBeInTheDocument();
    await settle();
    expect(calls).toHaveLength(1);
    expect(screen.getByText('חצי')).toBeInTheDocument();
  });

  it('does not ask again when she moved on before the app came back to it', async () => {
    const { calls } = openApp();
    await say('שלום');
    leaveApp();
    await breaks(calls[0]);
    // Something else is on the screen by the time the app is back (here: a new chat).
    await userEvent.click(screen.getByRole('button', { name: 'שיחה חדשה' }));
    comeBack();
    await settle();
    expect(calls).toHaveLength(1);
    expect(screen.getByRole('heading', { name: /על מה נדבר היום/ })).toBeInTheDocument();
  });
});

describe('the daily count', () => {
  it('counts another answer she asked for once, when it finally arrives after a cut', async () => {
    const { calls, sentNow } = openApp();
    await say('שלום');
    await writes(calls[0], 'ראשונה');
    await finishes(calls[0]);
    expect(sentNow()).toBe(1);

    // "Try again" on an answer that arrived is a paid call, counted when its answer starts.
    await userEvent.click(screen.getByRole('button', { name: 'נסי שוב' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    leaveApp();
    comeBack();
    await breaks(calls[1]);
    await waitFor(() => expect(calls).toHaveLength(3));
    // Nothing arrived yet, so nothing was counted, and the first answer is back meanwhile.
    expect(sentNow()).toBe(1);
    await writes(calls[2], 'שנייה');
    expect(sentNow()).toBe(2);
    await finishes(calls[2]);
    expect(screen.getByText('שנייה')).toBeInTheDocument();
    expect(screen.queryByText('ראשונה')).not.toBeInTheDocument();
    expect(sentNow()).toBe(2);
  });

  it('does not count twice when the cut answer had already started', async () => {
    const { calls, sentNow } = openApp();
    await say('שלום');
    await writes(calls[0], 'ראשונה');
    await finishes(calls[0]);
    await userEvent.click(screen.getByRole('button', { name: 'נסי שוב' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    await writes(calls[1], 'חצי');
    expect(sentNow()).toBe(2);
    leaveApp();
    comeBack();
    await breaks(calls[1]);
    await waitFor(() => expect(calls).toHaveLength(3));
    await writes(calls[2], 'שנייה');
    await finishes(calls[2]);
    expect(sentNow()).toBe(2);
  });
});

describe('saving when the app leaves the screen', () => {
  const lastSaved = (store: ReturnType<typeof memoryStore>) => [...store.chats.values()][0].messages.at(-1)!;

  it('saves what was written so far, marked as cut, in case the phone closes the app for good', async () => {
    const store = memoryStore();
    const { calls } = openApp({ store });
    await say('שלום');
    await waitFor(() => expect(store.chats.size).toBe(1));
    await writes(calls[0], 'חצי תשובה');
    // Until the app leaves, only her message is on the phone.
    expect(lastSaved(store)).toMatchObject({ role: 'user', text: 'שלום' });

    leaveApp();
    expect(lastSaved(store)).toMatchObject({ role: 'assistant', text: 'חצי תשובה', state: 'failed' });

    // The connection survived: the whole answer is saved over the half, with no mark.
    comeBack();
    await writes(calls[0], ' ועוד');
    await finishes(calls[0]);
    await waitFor(() => expect(lastSaved(store).text).toBe('חצי תשובה ועוד'));
    expect(lastSaved(store)).not.toHaveProperty('state');
    expect([...store.chats.values()][0].messages).toHaveLength(2);
  });

  it('saves nothing extra when no piece has arrived yet, or when no answer is being written', async () => {
    const store = memoryStore();
    const { calls } = openApp({ store });
    leaveApp();
    comeBack();
    expect(store.chats.size).toBe(0);

    await say('שלום');
    await waitFor(() => expect(store.chats.size).toBe(1));
    leaveApp();
    expect([...store.chats.values()][0].messages).toHaveLength(1);
    comeBack();
    await writes(calls[0], 'הנה');
    await finishes(calls[0]);
    await waitFor(() => expect(lastSaved(store)).toMatchObject({ role: 'assistant', text: 'הנה' }));

    // The answer is done: leaving again writes nothing.
    const before = JSON.stringify([...store.chats.values()]);
    leaveApp();
    expect(JSON.stringify([...store.chats.values()])).toBe(before);
  });

  it("saves nothing in a parent's own use, and asks again still without the child instructions", async () => {
    const store = memoryStore();
    const { calls, phone } = openApp({ store });
    phone.settings = { ...SETTINGS, parentUse: true };
    await say('hello');
    await writes(calls[0], 'half an answer');
    leaveApp();
    expect(store.chats.size).toBe(0);
    comeBack();
    await breaks(calls[0]);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].request.kidUse).toBe(false);
    await writes(calls[1], 'whole answer');
    await finishes(calls[1]);
    await settle();
    expect(store.chats.size).toBe(0);
  });

  it('does not bring back a chat the parent deleted meanwhile', async () => {
    const store = memoryStore();
    const { calls } = openApp({ store });
    await say('שלום');
    await waitFor(() => expect(store.chats.size).toBe(1));
    await writes(calls[0], 'חצי');
    await store.clear();
    leaveApp();
    await settle();
    expect(store.chats.size).toBe(0);
  });

  it('keeps working on a phone with no storage', async () => {
    const { calls } = openApp();
    await say('שלום');
    await writes(calls[0], 'חצי');
    leaveApp();
    comeBack();
    await writes(calls[0], ' ועוד');
    await finishes(calls[0]);
    expect(screen.getByText('חצי ועוד')).toBeInTheDocument();
  });
});
