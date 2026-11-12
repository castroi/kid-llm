import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AiError } from '../ai/providers';
import type { ChatRequest } from '../ai/send';
import { AttachmentError, type Attachment } from '../core/attachment';
import { attachmentMessage } from '../core/kidMessages';
import type { ChatStore } from '../storage/chatStore';
import type { Settings } from '../storage/settings';
import { fakeParent } from '../test/fakeParent';
import { memoryStore } from '../test/memoryStore';
import { App } from './App';
import type { Services } from './useChat';

const PDF: Attachment = { kind: 'pdf', bytes: new TextEncoder().encode('%PDF-1.7').buffer, name: 'דף עבודה.pdf' };
const PHOTO: Attachment = { kind: 'image', bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]).buffer, name: '' };

const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;
beforeAll(() => {
  // jsdom has no picture addresses of its own.
  let made = 0;
  URL.createObjectURL = vi.fn(() => `blob:attached-${++made}`);
  URL.revokeObjectURL = vi.fn();
});
afterAll(() => {
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

interface Options {
  /** How the provider answers each call, by its number; it answers "תשובה" otherwise. */
  fails?: (call: number) => AiError | null;
  fileModel?: string;
  prepare?: (file: File) => Promise<Attachment>;
  store?: ChatStore | null;
  parentUse?: true;
}

function openApp(options: Options = {}) {
  const requests: ChatRequest[] = [];
  const picked: File[] = [];
  let id = 0;
  // The parent can change this while the app is open.
  const settings: Settings = {
    provider: 'venice',
    models: { chat: 'chat-model', search: 'search-model', math: 'math-model', draw: 'image-model' },
    systemPrompt: '',
    childName: '',
    dailyLimit: null,
    ...(options.fileModel === '' ? {} : { fileModel: options.fileModel ?? 'vision-model' }),
    ...(options.parentUse ? { parentUse: true as const } : {}),
  };
  const services: Services = {
    store: options.store ?? null,
    loadSettings: () => settings,
    loadApiKey: () => 'sk-test',
    sendChat: async (request) => {
      requests.push(request);
      const failure = options.fails?.(requests.length) ?? null;
      if (failure) throw failure;
      request.onDelta('תשובה');
      return { text: 'תשובה', finishReason: 'stop' };
    },
    prepareAttachment: (file) => {
      picked.push(file);
      return (options.prepare ?? (async () => PDF))(file);
    },
    generateImage: () => Promise.reject(new Error('no drawing in this test')),
    sentToday: () => 0,
    countMessage: () => true,
    now: () => 1_700_000_000_000 + id,
    newId: () => `id-${++id}`,
    copyText: async () => undefined,
  };
  render(<App services={services} parent={fakeParent().parent} />);
  return { requests, picked, settings };
}

const attachButton = () => screen.queryByRole('button', { name: 'צירוף קובץ' });
const sheet = () => new File(['%PDF-1.7'], 'דף עבודה.pdf', { type: 'application/pdf' });

async function attach(file: File = sheet()) {
  await userEvent.upload(screen.getByLabelText('קובץ לצירוף'), file);
}

async function say(text: string, answers = 1) {
  await userEvent.type(screen.getByLabelText('הודעה'), text);
  await userEvent.click(screen.getByRole('button', { name: 'שליחה' }));
  await waitFor(() => expect(screen.getAllByText('תשובה')).toHaveLength(answers));
}

const pick = (name: RegExp) => userEvent.click(within(screen.getByRole('group', { name: 'מצב' })).getByRole('button', { name }));

async function pickFromSheet(name: RegExp) {
  await userEvent.click(document.querySelector('.mode-chip') as HTMLElement);
  await userEvent.click(within(screen.getByRole('dialog', { name: 'במה להשתמש עכשיו?' })).getByRole('button', { name }));
}

describe('attaching a file', () => {
  it('is not offered until the parent chose a model for files', () => {
    openApp({ fileModel: '' });
    expect(attachButton()).not.toBeInTheDocument();
    expect(screen.queryByLabelText('קובץ לצירוף')).not.toBeInTheDocument();
  });

  it('is offered in chat and maths, never in search or drawing', async () => {
    openApp();
    expect(attachButton()).toBeInTheDocument();
    await pick(/חשבון/);
    expect(attachButton()).toBeInTheDocument();
    await pick(/חיפוש/);
    expect(attachButton()).not.toBeInTheDocument();
    await pick(/ציור/);
    expect(attachButton()).not.toBeInTheDocument();
  });

  it("sends the file with her message to the files' model, and shows it in her message by her name for it", async () => {
    const { requests, picked } = openApp();
    await attach();
    expect(picked.map((file) => file.name)).toEqual(['דף עבודה.pdf']);
    expect(await screen.findByText('דף עבודה.pdf')).toBeInTheDocument();
    // A message needs words of hers too: the file alone is not sent.
    expect(screen.getByRole('button', { name: 'שליחה' })).toBeDisabled();
    await say('מה כתוב כאן?');

    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe('vision-model');
    expect(requests[0].webSearch).toBe(false);
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'מה כתוב כאן?', file: { kind: 'pdf', bytes: PDF.bytes } }]);
    // Her name for the file stays on the phone.
    expect(requests[0].messages[0].file).not.toHaveProperty('name');
    // The waiting file is gone from the message box, and is shown inside her message.
    expect(screen.queryByRole('button', { name: 'הסרת הקובץ' })).not.toBeInTheDocument();
    expect(within(document.querySelector('.bubble') as HTMLElement).getByText('דף עבודה.pdf')).toBeInTheDocument();
    // The answer is marked with the mode's name, never a model's.
    expect(document.body.textContent).not.toContain('vision-model');
  });

  it("sends a file to the files' model in a parent's own use too, and says the child baseline is to be left out", async () => {
    const { requests } = openApp({ parentUse: true });
    await attach();
    await say('what does it say?');
    expect(requests[0]).toMatchObject({ model: 'vision-model', webSearch: false, kidUse: false });
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'what does it say?', file: { kind: 'pdf', bytes: PDF.bytes } }]);
  });

  it('sends the same file again with a follow-up, and goes back to the mode\'s own model in a new chat', async () => {
    const { requests } = openApp();
    await attach();
    await say('מה כתוב כאן?');
    await say('ושאלה 2?', 2);
    expect(requests[1].model).toBe('vision-model');
    expect(requests[1].messages[0].file).toEqual({ kind: 'pdf', bytes: PDF.bytes });
    expect(requests[1].messages[2]).toEqual({ role: 'user', content: 'ושאלה 2?' });

    await userEvent.click(screen.getByRole('button', { name: 'שיחה חדשה' }));
    await say('שלום');
    expect(requests[2].model).toBe('chat-model');
    expect(requests[2].messages).toEqual([{ role: 'user', content: 'שלום' }]);
  });

  it('shows a picture she attached inside her message', async () => {
    openApp({ prepare: async () => PHOTO });
    await attach(new File(['x'], 'IMG_0042.jpg', { type: 'image/jpeg' }));
    // A picture waits under a plain word, not under the camera's file name.
    expect(await screen.findByText('תמונה')).toBeInTheDocument();
    expect(screen.queryByText('IMG_0042.jpg')).not.toBeInTheDocument();
    await say('מה יש בתמונה?');
    expect(await screen.findByRole('img', { name: 'התמונה שצירפתי' })).toHaveAttribute('src', expect.stringMatching(/^blob:/));
  });

  it('lets her take the file off before sending', async () => {
    const { requests } = openApp();
    await attach();
    await userEvent.click(await screen.findByRole('button', { name: 'הסרת הקובץ' }));
    expect(screen.queryByText('דף עבודה.pdf')).not.toBeInTheDocument();
    await say('שלום');
    expect(requests[0].model).toBe('chat-model');
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'שלום' }]);
  });

  it.each(['unsupported', 'too-large', 'unreadable'] as const)('tells her in one friendly line when a file cannot be attached (%s), and attaches nothing', async (problem) => {
    const { requests } = openApp({ prepare: () => Promise.reject(new AttachmentError(problem)) });
    await attach();
    expect(await screen.findByText(attachmentMessage(problem))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'הסרת הקובץ' })).not.toBeInTheDocument();
    await say('שלום');
    expect(requests[0].model).toBe('chat-model');
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'שלום' }]);
  });

  it('shows the same friendly line for a failure it does not know, without its text', async () => {
    openApp({ prepare: () => Promise.reject(new Error('cannot read דף עבודה.pdf at /private/var')) });
    await attach();
    expect(await screen.findByText(attachmentMessage('unreadable'))).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('/private/var');
  });

  it('leaves the file behind when she moves to search: a search never carries a file', async () => {
    const { requests } = openApp();
    await attach();
    await screen.findByText('דף עבודה.pdf');
    await pick(/חיפוש/);
    expect(screen.queryByText('דף עבודה.pdf')).not.toBeInTheDocument();
    await say('מי המציא את הטלפון?');
    expect(requests[0].model).toBe('search-model');
    expect(requests[0].webSearch).toBe(true);
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'מי המציא את הטלפון?' }]);
  });

  it('does not hand a file from the chat to a search asked later in the same chat', async () => {
    const { requests } = openApp();
    await attach();
    await say('מה כתוב כאן?');
    await pickFromSheet(/חיפוש/);
    await say('מי המציא את הטלפון?', 2);
    expect(requests[1].webSearch).toBe(true);
    expect(requests[1].messages).toEqual([{ role: 'user', content: 'מי המציא את הטלפון?' }]);
  });

  it('keeps the file on the phone, and stops sending it, once the parent takes the files\' model away', async () => {
    const { requests, settings } = openApp();
    await attach();
    await say('מה כתוב כאן?');
    delete settings.fileModel;
    await say('ושאלה 2?', 2);
    expect(requests[1].model).toBe('chat-model');
    expect(requests[1].messages.some((message) => message.file !== undefined)).toBe(false);
    expect(requests[1].messages[0]).toEqual({ role: 'user', content: 'מה כתוב כאן?' });
  });

  it('keeps the file with its chat on the phone', async () => {
    const store = memoryStore();
    openApp({ store });
    await attach();
    await say('מה כתוב כאן?');
    await waitFor(() => expect([...store.chats.values()][0]?.messages).toHaveLength(2));
    expect([...store.chats.values()][0].messages[0].attachment).toEqual(PDF);
  });

  it('asks again with the file on "try again", and never hands it to a search asked again', async () => {
    const { requests } = openApp();
    await attach();
    await say('מה כתוב כאן?');
    await userEvent.click(screen.getByRole('button', { name: 'נסי שוב' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].model).toBe('vision-model');
    expect(requests[1].messages).toEqual([{ role: 'user', content: 'מה כתוב כאן?', file: { kind: 'pdf', bytes: PDF.bytes } }]);

    await pickFromSheet(/חיפוש/);
    await say('מי המציא את הטלפון?', 2);
    await userEvent.click(screen.getByRole('button', { name: 'נסי שוב' }));
    await waitFor(() => expect(requests).toHaveLength(4));
    expect(requests[3].webSearch).toBe(true);
    expect(requests[3].model).toBe('search-model');
    expect(requests[3].messages).toEqual([{ role: 'user', content: 'מי המציא את הטלפון?' }]);
  });

  it('sends the file of a chat opened again from her list with a follow-up', async () => {
    const store = memoryStore([
      {
        id: 'old',
        title: 'דף עבודה',
        mode: 'chat',
        createdAt: 1,
        updatedAt: 2,
        messages: [
          { id: 'q', role: 'user', text: 'מה כתוב כאן?', at: 1, mode: 'chat', attachment: PDF },
          { id: 'a', role: 'assistant', text: 'תרגיל בשברים', at: 2, mode: 'chat' },
        ],
      },
    ]);
    const { requests } = openApp({ store });
    await userEvent.click(screen.getByRole('button', { name: 'השיחות שלי' }));
    await userEvent.click(await within(screen.getByRole('dialog', { name: 'השיחות שלי' })).findByRole('button', { name: 'דף עבודה' }));
    await screen.findByText('תרגיל בשברים');
    await say('ושאלה 2?');
    expect(requests[0].model).toBe('vision-model');
    expect(requests[0].messages[0]).toEqual({ role: 'user', content: 'מה כתוב כאן?', file: { kind: 'pdf', bytes: PDF.bytes } });
  });

  it('stops sending a file the provider would not take, so the chat is not stuck on it', async () => {
    const store = memoryStore();
    const { requests } = openApp({ store, fails: (call) => (call === 1 ? new AiError('bad-request', '400 model does not support files') : null) });
    await attach();
    await userEvent.type(screen.getByLabelText('הודעה'), 'מה כתוב כאן?');
    await userEvent.click(screen.getByRole('button', { name: 'שליחה' }));
    expect(await screen.findByText('משהו לא עובד. כדאי לקרוא לאבא או לאמא.')).toBeInTheDocument();
    // The provider's own words never reach her.
    expect(document.body.textContent).not.toContain('does not support');
    expect(requests[0].messages[0].file).toBeDefined();

    // Her next message goes without the file, to the mode's own model, and is answered.
    await say('אז בלי הקובץ: מה זה שבר?');
    expect(requests[1].model).toBe('chat-model');
    expect(requests[1].messages.some((message) => message.file !== undefined)).toBe(false);
    // The file is still shown in her message and kept on the phone, marked as refused.
    expect(within(document.querySelector('.bubble') as HTMLElement).getByText('דף עבודה.pdf')).toBeInTheDocument();
    await waitFor(() => expect([...store.chats.values()][0]?.messages[0].attachment?.refused).toBe(true));
  });

  it('keeps sending the file after a failure that is not about the file', async () => {
    const { requests } = openApp({ fails: (call) => (call === 1 ? new AiError('network') : null) });
    await attach();
    await userEvent.type(screen.getByLabelText('הודעה'), 'מה כתוב כאן?');
    await userEvent.click(screen.getByRole('button', { name: 'שליחה' }));
    await userEvent.click(await screen.findByRole('button', { name: 'ננסה שוב' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].messages[0].file).toEqual({ kind: 'pdf', bytes: PDF.bytes });
  });
});
