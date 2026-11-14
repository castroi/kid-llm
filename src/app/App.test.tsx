import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AiError, type ChatResult } from '../ai/providers';
import type { ChatRequest } from '../ai/send';
import { MAX_MESSAGE_CHARS, type Chat } from '../core/chat';
import { LIMIT_MESSAGE, NOT_SAVED_MESSAGE, PARENT_USE_MESSAGE, SETUP_MESSAGE } from '../core/kidMessages';
import type { ChatStore } from '../storage/chatStore';
import type { Settings } from '../storage/settings';
import { fakeParent } from '../test/fakeParent';
import { App } from './App';
import type { Services } from './useChat';

const SETTINGS: Settings = {
  provider: 'venice',
  models: { chat: 'model-chat', search: 'model-search', math: 'model-math', draw: 'model-draw' },
  systemPrompt: 'Be kind.',
  childName: 'נועה',
  dailyLimit: null,
};

type Send = (request: ChatRequest) => Promise<ChatResult>;

/** A provider that writes the given pieces and finishes. */
const answers =
  (...pieces: string[]): Send =>
  async (request) => {
    for (const piece of pieces) request.onDelta(piece);
    return { text: pieces.join(''), finishReason: 'stop' };
  };

/** A provider that writes the given pieces and then keeps the call open until she stops it. */
const hangsAfter =
  (...pieces: string[]): Send =>
  (request) =>
    new Promise((_, reject) => {
      for (const piece of pieces) request.onDelta(piece);
      request.signal?.addEventListener('abort', () => reject(new AiError('cancelled')));
    });

function fakeStore(): ChatStore & { saved: Chat[]; updated: Chat[] } {
  const saved: Chat[] = [];
  const updated: Chat[] = [];
  return {
    saved,
    updated,
    list: async () => [],
    get: async () => undefined,
    all: async () => [],
    save: async (chat) => void saved.push(chat),
    update: async (chat) => {
      updated.push(chat);
      return true;
    },
    rename: async () => true,
    clear: async () => undefined,
    close: () => undefined,
  };
}

interface Options {
  settings?: Partial<Settings>;
  apiKey?: string;
  send?: Send;
  store?: ChatStore | null;
  sentToday?: number;
  /** The phone refuses to write the daily count. */
  countFails?: boolean;
}

function open(options: Options = {}) {
  const requests: ChatRequest[] = [];
  const send = options.send ?? answers('היי ', 'לך!');
  const store = options.store === undefined ? fakeStore() : options.store;
  let sent = options.sentToday ?? 0;
  let id = 0;
  const copyText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  const services: Services = {
    store,
    loadSettings: () => ({ ...SETTINGS, ...options.settings }),
    loadApiKey: () => options.apiKey ?? 'sk-test',
    sendChat: (request) => {
      requests.push(request);
      return send(request);
    },
    prepareAttachment: () => Promise.reject(new Error('no files in this test')),
    generateImage: () => Promise.reject(new Error('no drawing in this test')),
    sentToday: () => sent,
    countMessage: () => {
      if (options.countFails) return false;
      sent += 1;
      return true;
    },
    now: () => 1_700_000_000_000 + id,
    newId: () => `id-${++id}`,
    copyText,
  };
  render(<App services={services} parent={fakeParent().parent} />);
  return { requests, store, copyText, sentNow: () => sent };
}

const box = () => screen.getByLabelText('הודעה') as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: 'שליחה' });

async function say(text: string) {
  await userEvent.type(box(), text);
  await userEvent.click(sendButton());
}

describe('opening screen', () => {
  it('greets her by name and shows every mode by its name, never a model name', () => {
    open();
    expect(screen.getByRole('heading', { name: 'היי נועה, על מה נדבר היום?' })).toBeInTheDocument();
    const modes = within(screen.getByRole('group', { name: 'מצב' })).getAllByRole('button');
    expect(modes.map((m) => m.textContent)).toEqual(['שיחהלדבר על כל דבר', 'חיפושלמצוא תשובות באינטרנט', 'חשבוןעזרה בתרגילים', 'ציורליצור תמונה']);
    expect(document.body.textContent).not.toContain('model-');
  });

  it('greets without a name when the parent gave none', () => {
    open({ settings: { childName: '' } });
    expect(screen.getByRole('heading', { name: 'היי, על מה נדבר היום?' })).toBeInTheDocument();
  });

  it('starts on plain chat and lets her pick any mode', async () => {
    open();
    const group = within(screen.getByRole('group', { name: 'מצב' }));
    expect(group.getByRole('button', { name: /שיחה/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(group.getByRole('button', { name: /חשבון/ }));
    expect(group.getByRole('button', { name: /חשבון/ })).toHaveAttribute('aria-pressed', 'true');
    expect(group.getByRole('button', { name: /חיפוש/ })).toBeEnabled();
    expect(group.getByRole('button', { name: /ציור/ })).toBeEnabled();
  });

  it('tells her to call a parent, and sends nothing, until a parent has set the chat up', async () => {
    const noKey = open({ apiKey: '' });
    expect(screen.getByText(SETUP_MESSAGE)).toBeInTheDocument();
    await userEvent.type(box(), 'שלום');
    expect(sendButton()).toBeDisabled();
    expect(noKey.requests).toHaveLength(0);
  });

  it('says the same when the mode she is in has no model yet', () => {
    open({ settings: { models: { ...SETTINGS.models, chat: '' } } });
    expect(screen.getByText(SETUP_MESSAGE)).toBeInTheDocument();
  });
});

describe('chatting', () => {
  it('shows her message, writes the answer as it arrives, and names the chat after her message', async () => {
    const { requests } = open();
    await say('למה השמיים כחולים?');
    expect(await screen.findByText('היי לך!')).toBeInTheDocument();
    expect(screen.getByText('למה השמיים כחולים?', { selector: '.bubble' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'למה השמיים כחולים?' })).toBeInTheDocument();
    expect(box().value).toBe('');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      provider: 'venice',
      model: 'model-chat',
      systemPrompt: 'Be kind.',
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'למה השמיים כחולים?' }],
    });
  });

  it('resends the whole conversation with each new message', async () => {
    const { requests } = open();
    await say('אחת');
    await screen.findByText('היי לך!');
    await say('שתיים');
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].messages).toEqual([
      { role: 'user', content: 'אחת' },
      { role: 'assistant', content: 'היי לך!' },
      { role: 'user', content: 'שתיים' },
    ]);
  });

  it('never sends her name to the provider', async () => {
    const { requests } = open();
    await say('שלום');
    await screen.findByText('היי לך!');
    expect(JSON.stringify(requests[0])).not.toContain('נועה');
  });

  it('shows the mode under an answer, never the model', async () => {
    open();
    await say('שלום');
    await screen.findByText('היי לך!');
    expect(screen.getByText(/^שיחה ·/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('model-chat');
  });

  it('uses the model of the mode she picked from the sheet', async () => {
    const { requests } = open();
    await userEvent.click(screen.getByRole('button', { name: 'שיחה' }));
    const sheet = within(screen.getByRole('dialog', { name: 'במה להשתמש עכשיו?' }));
    await userEvent.click(sheet.getByRole('button', { name: /חשבון/ }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await say('כמה זה 2+2?');
    await screen.findByText('היי לך!');
    expect(requests[0].model).toBe('model-math');
    expect(screen.getByText(/^חשבון ·/)).toBeInTheDocument();
  });

  it('keeps the screen behind the mode sheet out of reach, closes on Escape and gives the focus back', async () => {
    open();
    const chip = screen.getByRole('button', { name: 'שיחה' });
    await userEvent.click(chip);
    const sheet = screen.getByRole('dialog');
    expect(sheet).toContainElement(document.activeElement as HTMLElement);
    expect(box().closest('[inert]')).not.toBeNull();
    expect(sheet.closest('[inert]')).toBeNull();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(box().closest('[inert]')).toBeNull();
    expect(chip).toHaveFocus();
  });

  it('starts a chat in the new chat while the old call is still ending', async () => {
    let calls = 0;
    const send: Send = (request) => (++calls === 1 ? hangsAfter('ישן')(request) : answers('חדש')(request));
    const { requests } = open({ send });
    await say('אחת');
    await screen.findByText('ישן');
    await userEvent.click(screen.getByRole('button', { name: 'שיחה חדשה' }));
    await say('שתיים');
    expect(await screen.findByText('חדש')).toBeInTheDocument();
    expect(screen.queryByText('ישן')).not.toBeInTheDocument();
    expect(requests[1].messages).toEqual([{ role: 'user', content: 'שתיים' }]);
  });

  it('closes the mode sheet without changing anything when she taps outside it', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'שיחה' }));
    await userEvent.click(screen.getByRole('button', { name: 'סגירה' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'שיחה' })).toBeInTheDocument();
  });

  it('cuts a message that is longer than allowed', async () => {
    const { requests } = open();
    fireEvent.change(box(), { target: { value: 'א'.repeat(MAX_MESSAGE_CHARS + 500) } });
    await userEvent.click(sendButton());
    await screen.findByText('היי לך!');
    expect(requests[0].messages[0].content).toHaveLength(MAX_MESSAGE_CHARS);
    expect(box()).toHaveAttribute('maxlength', String(MAX_MESSAGE_CHARS));
  });

  it('does not send an empty message', async () => {
    const { requests } = open();
    await userEvent.type(box(), '   ');
    expect(sendButton()).toBeDisabled();
    fireEvent.submit(box().closest('form')!);
    expect(requests).toHaveLength(0);
  });

  it('starts a new, empty chat from the plus button', async () => {
    open();
    await say('שלום');
    await screen.findByText('היי לך!');
    await userEvent.click(screen.getByRole('button', { name: 'שיחה חדשה' }));
    expect(screen.getByRole('heading', { name: 'היי נועה, על מה נדבר היום?' })).toBeInTheDocument();
    expect(screen.queryByText('היי לך!')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'שיחה חדשה' })).toBeInTheDocument();
  });
});

describe('stopping', () => {
  it('shows the stop button while an answer is written, and keeps what was written when she stops', async () => {
    const { requests } = open({ send: hangsAfter('פעם אחת ') });
    await say('ספרי סיפור');
    expect(await screen.findByText('פעם אחת')).toBeInTheDocument();
    expect(screen.getByText('שיחה · כותבת עכשיו')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'שליחה' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'עצירה' }));
    expect(await screen.findByText(/עצרת כאן/)).toBeInTheDocument();
    expect(requests[0].signal?.aborted).toBe(true);
    expect(screen.getByText('פעם אחת')).toBeInTheDocument();
    expect(sendButton()).toBeInTheDocument();
    // Her stop is not a failure.
    expect(screen.queryByRole('button', { name: 'ננסה שוב' })).not.toBeInTheDocument();
  });

  it('removes the empty answer when she stops before anything was written', async () => {
    open({ send: hangsAfter() });
    await say('שלום');
    expect(await screen.findByText('חושבת...')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'עצירה' }));
    await waitFor(() => expect(screen.queryByText('חושבת...')).not.toBeInTheDocument());
    expect(screen.queryByText(/עצרת כאן/)).not.toBeInTheDocument();
  });

  it('does not send a second message while an answer is being written', async () => {
    const { requests } = open({ send: hangsAfter('רגע') });
    await say('אחת');
    await screen.findByText('רגע');
    await userEvent.type(box(), 'שתיים');
    fireEvent.submit(box().closest('form')!);
    expect(requests).toHaveLength(1);
    expect(box().value).toBe('שתיים');
  });

  it('stops the answer and leaves it out of the new chat when she starts a new chat meanwhile', async () => {
    const { requests } = open({ send: hangsAfter('ישן') });
    await say('אחת');
    await screen.findByText('ישן');
    await userEvent.click(screen.getByRole('button', { name: 'שיחה חדשה' }));
    expect(requests[0].signal?.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByText('ישן')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'היי נועה, על מה נדבר היום?' })).toBeInTheDocument();
    expect(sendButton()).toBeInTheDocument();
  });
});

describe('when something fails', () => {
  it('says there is no internet and tries again with the same message, not a second copy', async () => {
    let calls = 0;
    const send: Send = (request) => (++calls === 1 ? Promise.reject(new AiError('network', 'TypeError')) : answers('הנה!')(request));
    const { requests } = open({ send });
    await say('שלום');
    expect(await screen.findByText('אין אינטרנט כרגע. ננסה שוב?')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'ננסה שוב' }));
    expect(await screen.findByText('הנה!')).toBeInTheDocument();
    expect(requests[1].messages).toEqual(requests[0].messages);
    expect(screen.getAllByText('שלום', { selector: '.bubble' })).toHaveLength(1);
    expect(screen.queryByText('אין אינטרנט כרגע. ננסה שוב?')).not.toBeInTheDocument();
  });

  it("sends her to a parent for a problem only a parent can fix, and never shows the provider's own words", async () => {
    open({ send: () => Promise.reject(new AiError('unauthorized', '401 secret provider text')) });
    await say('שלום');
    expect(await screen.findByText('משהו לא עובד. כדאי לקרוא לאבא או לאמא.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ננסה שוב' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('secret provider text');
    expect(document.body.textContent).not.toContain('401');
  });

  it('treats an unexpected error like a broken answer, without showing its text', async () => {
    open({ send: () => Promise.reject(new Error('internal detail')) });
    await say('שלום');
    expect(await screen.findByText('משהו לא עבד הפעם. ננסה שוב?')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('internal detail');
  });

  it('keeps the part of an answer that arrived before the failure, marked as cut off', async () => {
    const send: Send = async (request) => {
      request.onDelta('חצי תשובה');
      throw new AiError('network');
    };
    open({ send });
    await say('שלום');
    expect(await screen.findByText(/התשובה נקטעה/)).toBeInTheDocument();
    expect(screen.getByText('חצי תשובה')).toBeInTheDocument();
  });

  it('keeps the answer she had when asking for another one fails or is stopped before anything new arrives', async () => {
    let calls = 0;
    const send: Send = (request) => (++calls === 1 ? answers('ראשונה')(request) : calls === 2 ? Promise.reject(new AiError('network')) : hangsAfter()(request));
    const store = fakeStore();
    const { sentNow } = open({ send, store, settings: { dailyLimit: 5 } });
    await say('שלום');
    await screen.findByText('ראשונה');

    await userEvent.click(screen.getByRole('button', { name: 'נסי שוב' }));
    expect(await screen.findByText('אין אינטרנט כרגע. ננסה שוב?')).toBeInTheDocument();
    expect(screen.getByText('ראשונה')).toBeInTheDocument();
    // No new answer arrived, so nothing was taken from her day.
    expect(sentNow()).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'נסי שוב' }));
    await userEvent.click(await screen.findByRole('button', { name: 'עצירה' }));
    expect(await screen.findByText('ראשונה')).toBeInTheDocument();
    await waitFor(() => expect(store.updated.length).toBeGreaterThanOrEqual(3));
    expect(store.updated.at(-1)!.messages.map((m) => m.text)).toEqual(['שלום', 'ראשונה']);
  });

  it('asks again for the last answer with "נסי שוב", replacing it', async () => {
    let calls = 0;
    const send: Send = (request) => answers(++calls === 1 ? 'ראשונה' : 'שנייה')(request);
    const { requests } = open({ send });
    await say('שלום');
    await screen.findByText('ראשונה');
    await userEvent.click(screen.getByRole('button', { name: 'נסי שוב' }));
    expect(await screen.findByText('שנייה')).toBeInTheDocument();
    expect(screen.queryByText('ראשונה')).not.toBeInTheDocument();
    expect(requests[1].messages).toEqual([{ role: 'user', content: 'שלום' }]);
  });
});

describe('the daily limit', () => {
  it('counts each message she sends', async () => {
    const { sentNow } = open({ settings: { dailyLimit: 5 } });
    await say('שלום');
    await screen.findByText('היי לך!');
    expect(sentNow()).toBe(1);
  });

  it('stops her kindly at the limit, sends nothing and keeps what she typed', async () => {
    const { requests, sentNow } = open({ settings: { dailyLimit: 2 }, sentToday: 2 });
    await say('עוד אחת');
    expect(await screen.findByText(LIMIT_MESSAGE)).toBeInTheDocument();
    expect(requests).toHaveLength(0);
    expect(sentNow()).toBe(2);
    expect(box().value).toBe('עוד אחת');
  });

  it('counts asking for another answer like a message, and refuses it at the limit', async () => {
    const { requests, sentNow } = open({ settings: { dailyLimit: 2 } });
    await say('שלום');
    await screen.findByText('היי לך!');
    await userEvent.click(screen.getByRole('button', { name: 'נסי שוב' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(sentNow()).toBe(2);

    await userEvent.click(await screen.findByRole('button', { name: 'נסי שוב' }));
    expect(await screen.findByText(LIMIT_MESSAGE)).toBeInTheDocument();
    expect(requests).toHaveLength(2);
    expect(screen.getByText('היי לך!')).toBeInTheDocument();
  });

  it('does not count trying again after a failure', async () => {
    let calls = 0;
    const send: Send = (request) => (++calls === 1 ? Promise.reject(new AiError('network')) : answers('הנה!')(request));
    const { sentNow } = open({ settings: { dailyLimit: 1 }, send });
    await say('שלום');
    await userEvent.click(await screen.findByRole('button', { name: 'ננסה שוב' }));
    expect(await screen.findByText('הנה!')).toBeInTheDocument();
    expect(sentNow()).toBe(1);
  });

  it('still holds when the phone cannot write the count', async () => {
    const { requests } = open({ settings: { dailyLimit: 1 }, countFails: true });
    await say('אחת');
    await screen.findByText('היי לך!');
    await say('שתיים');
    expect(await screen.findByText(LIMIT_MESSAGE)).toBeInTheDocument();
    expect(requests).toHaveLength(1);
  });
});

describe("a parent's own use", () => {
  it('is off unless the parent switched it on: no notice, and the call asks for nothing but a child\'s chat', async () => {
    const { requests } = open();
    expect(screen.queryByText(PARENT_USE_MESSAGE)).not.toBeInTheDocument();
    await say('שלום');
    await screen.findByText('היי לך!');
    expect(requests[0]).not.toHaveProperty('kidUse');
    expect(requests[0].systemPrompt).toBe('Be kind.');
  });

  it('says so on the chat screen for as long as it is on, and sends the call without the child baseline', async () => {
    const { requests } = open({ settings: { parentUse: true } });
    expect(screen.getByRole('note')).toHaveTextContent(PARENT_USE_MESSAGE);
    await say('שלום');
    await screen.findByText('היי לך!');
    expect(requests[0].kidUse).toBe(false);
    expect(requests[0].systemPrompt).toBe('Be kind.');
    // Still there with a conversation on the screen.
    expect(screen.getByRole('note')).toHaveTextContent(PARENT_USE_MESSAGE);
  });

  it("writes nothing of a parent's own chat to the phone, and says that the chat isn't saved", async () => {
    const store = fakeStore();
    const { requests } = open({ store, settings: { parentUse: true } });
    await say('שלום');
    await screen.findByText('היי לך!');
    await userEvent.click(screen.getByRole('button', { name: 'נסי שוב' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    await screen.findByText('היי לך!');
    expect(store.saved).toEqual([]);
    expect(store.updated).toEqual([]);
    expect(screen.getByText(NOT_SAVED_MESSAGE)).toBeInTheDocument();
  });

  it("makes an address the model wrote a link, shown by its site's name, only in a parent's own use", async () => {
    const text = 'חיפוש: [לחץ כאן](https://www.google.com/search?q=18V) או http://plain.example.com';
    open({ settings: { parentUse: true }, send: answers(text) });
    await say('שלום');
    const link = await screen.findByRole('link', { name: 'google.com' });
    expect(link).toHaveAttribute('href', 'https://www.google.com/search?q=18V');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
    // Not https: stays text.
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByText('http://plain.example.com')).toBeInTheDocument();
  });

  it('shows only the real site when the label is itself an address', async () => {
    open({ settings: { parentUse: true }, send: answers('[https://google.com](https://evil.example.com/x)') });
    await say('שלום');
    expect(await screen.findByRole('link', { name: 'evil.example.com' })).toBeInTheDocument();
    expect(screen.queryByText(/google\.com/)).not.toBeInTheDocument();
  });

  it('never makes the model\'s address a link for her', async () => {
    open({ send: answers('[לחץ כאן](https://www.google.com/search?q=18V)') });
    await say('שלום');
    expect(await screen.findByText('https://www.google.com/search?q=18V')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('asks again without the child baseline on "try again" too', async () => {
    const { requests } = open({ settings: { parentUse: true } });
    await say('שלום');
    await screen.findByText('היי לך!');
    await userEvent.click(screen.getByRole('button', { name: 'נסי שוב' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].kidUse).toBe(false);
  });
});

describe('copying', () => {
  it('copies the answer as clean text and says so', async () => {
    const { copyText } = open({ send: answers('**מודגש** ו`קוד`') });
    await say('שלום');
    await screen.findByText('מודגש');
    await userEvent.click(screen.getByRole('button', { name: 'העתקה' }));
    expect(copyText).toHaveBeenCalledWith('מודגש וקוד');
    expect(await screen.findByText('הועתק!')).toBeInTheDocument();
  });

  it('changes nothing when the browser refuses to copy', async () => {
    const { copyText } = open();
    copyText.mockRejectedValue(new Error('denied'));
    await say('שלום');
    await screen.findByText('היי לך!');
    await userEvent.click(screen.getByRole('button', { name: 'העתקה' }));
    expect(screen.queryByText('הועתק!')).not.toBeInTheDocument();
  });
});

describe('copying her own message', () => {
  const mine = () => screen.getByRole('button', { name: 'העתקה של מה שכתבתי' });

  it('copies what she wrote exactly as she wrote it, signs and all, and says so', async () => {
    const { copyText } = open();
    await say('כמה זה 2*3*4 ו-**5**?');
    await screen.findByText('היי לך!');
    await userEvent.click(mine());
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(copyText).toHaveBeenCalledWith('כמה זה 2*3*4 ו-**5**?');
    expect(await screen.findByText('הועתק!')).toBeInTheDocument();
    // A screen reader hears "copied" too: the button's own name gives way to what it shows.
    expect(screen.getByRole('button', { name: 'הועתק!' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'העתקה של מה שכתבתי' })).not.toBeInTheDocument();
    // The answer's own button is still there, and still says what it does.
    expect(screen.getByRole('button', { name: 'העתקה' })).toBeInTheDocument();
  });

  it('is there while the answer is still being written', async () => {
    const { copyText } = open({ send: () => new Promise(() => undefined) });
    await say('שלום');
    await userEvent.click(mine());
    expect(copyText).toHaveBeenCalledWith('שלום');
  });

  it('gives every message of hers its own button', async () => {
    const { copyText } = open();
    await say('ראשונה');
    await screen.findByText('היי לך!');
    await say('שנייה');
    await waitFor(() => expect(screen.getAllByText('היי לך!')).toHaveLength(2));
    const buttons = screen.getAllByRole('button', { name: 'העתקה של מה שכתבתי' });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[0]);
    expect(copyText).toHaveBeenCalledWith('ראשונה');
  });

  it('changes nothing when the browser refuses to copy', async () => {
    const { copyText } = open();
    copyText.mockRejectedValue(new Error('denied'));
    await say('שלום');
    await screen.findByText('היי לך!');
    await userEvent.click(mine());
    expect(screen.queryByText('הועתק!')).not.toBeInTheDocument();
  });
});

describe('how an answer is shown', () => {
  it('shows maths left to right inside Hebrew, code in its own box, and tags as plain text', async () => {
    open({ send: answers('התשובה: 3/4 = 6/8.\n```\nprint(1)\n```\n<b>לא מודגש</b>') });
    await say('שלום');
    const maths = await screen.findByText('3/4 = 6/8');
    expect(maths.tagName).toBe('BDI');
    expect(maths).toHaveAttribute('dir', 'ltr');
    expect(screen.getByText('print(1)').closest('pre')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByText('<b>לא מודגש</b>')).toBeInTheDocument();
    expect(document.querySelector('.answer-text b')).toBeNull();
  });
});

describe('saving on the phone', () => {
  it('saves her message at once and the finished answer after it', async () => {
    const store = fakeStore();
    open({ store });
    await say('שלום');
    await screen.findByText('היי לך!');
    await waitFor(() => expect(store.updated).toHaveLength(1));
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0].messages.map((m) => [m.role, m.text])).toEqual([['user', 'שלום']]);
    // The end of an answer is written only if the chat is still there (store.update), so a deleted chat can't come back.
    expect(store.updated[0].messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'שלום'],
      ['assistant', 'היי לך!'],
    ]);
    expect(JSON.stringify([store.saved, store.updated])).not.toContain('sk-test');
  });

  it('says so when the phone could not save', async () => {
    const store = fakeStore();
    store.save = () => Promise.reject(new Error('full'));
    store.update = () => Promise.reject(new Error('full'));
    open({ store });
    await say('שלום');
    expect(await screen.findByText(NOT_SAVED_MESSAGE)).toBeInTheDocument();
  });

  it('still lets her chat when the browser has no storage at all, and says that nothing is kept', async () => {
    open({ store: null });
    expect(screen.getByText(NOT_SAVED_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText('השיחות נשמרות רק באייפון הזה')).not.toBeInTheDocument();
    await say('שלום');
    expect(await screen.findByText('היי לך!')).toBeInTheDocument();
    expect(screen.getByText(NOT_SAVED_MESSAGE)).toBeInTheDocument();
  });

  it('keeps saying "not saved" when the first save failed and the chat is not on the phone at the end', async () => {
    const store = fakeStore();
    store.save = () => Promise.reject(new Error('full'));
    // Nothing to update: the chat never reached the phone.
    store.update = async () => false;
    open({ store });
    await say('שלום');
    await screen.findByText('היי לך!');
    expect(await screen.findByText(NOT_SAVED_MESSAGE)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText(NOT_SAVED_MESSAGE)).toBeInTheDocument();
  });

  it('says chats are kept on this iPhone when they are', () => {
    open();
    expect(screen.getByText('השיחות נשמרות רק באייפון הזה')).toBeInTheDocument();
  });
});
