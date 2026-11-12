import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AiError, type AiErrorReason, type ChatResult } from '../ai/providers';
import type { ChatRequest } from '../ai/send';
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
  models: { chat: 'model-chat', search: '', math: '', draw: '' },
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

function openApp(options: { store?: ChatStore | null } = {}) {
  const calls: Call[] = [];
  let sent = 0;
  let id = 0;
  const services: Services = {
    store: options.store ?? null,
    loadSettings: () => SETTINGS,
    loadApiKey: () => 'sk-test',
    sendChat: (request) =>
      new Promise<ChatResult>((resolve, reject) => {
        // Like the real call, her stop ends it.
        request.signal?.addEventListener('abort', () => reject(new AiError('cancelled')));
        calls.push({ request, finish: () => resolve({ text: 'whole', finishReason: 'stop' }), fail: (reason) => reject(new AiError(reason)) });
      }),
    prepareAttachment: () => Promise.reject(new Error('no files in this test')),
    generateImage: () => Promise.reject(new Error('no drawing in this test')),
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
  return { calls, sentNow: () => sent };
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
