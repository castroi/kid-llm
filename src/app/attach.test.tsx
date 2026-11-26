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
  /** How many pictures the model for files reads, as saved with its choice. */
  fileModelImages?: number;
  prepare?: (file: File, smaller: boolean) => Promise<Attachment>;
  store?: ChatStore | null;
  parentUse?: true;
}

function openApp(options: Options = {}) {
  const requests: ChatRequest[] = [];
  const picked: File[] = [];
  const smaller: boolean[] = [];
  let id = 0;
  // The parent can change this while the app is open.
  const settings: Settings = {
    provider: 'venice',
    models: { chat: 'chat-model', search: 'search-model', math: 'math-model', draw: 'image-model' },
    systemPrompt: '',
    childName: '',
    dailyLimit: null,
    ...(options.fileModel === '' ? {} : { fileModel: options.fileModel ?? 'vision-model' }),
    ...(options.fileModelImages ? { fileModelImages: options.fileModelImages } : {}),
    ...(options.parentUse ? { parentUse: true as const } : {}),
  };
  const copyText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
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
    prepareAttachment: (file, small) => {
      picked.push(file);
      smaller.push(small);
      return (options.prepare ?? (async () => PDF))(file, small);
    },
    generateImage: () => Promise.reject(new Error('no drawing in this test')),
    sentToday: () => 0,
    countMessage: () => true,
    now: () => 1_700_000_000_000 + id,
    newId: () => `id-${++id}`,
    copyText,
  };
  render(<App services={services} parent={fakeParent().parent} />);
  return { requests, picked, smaller, settings, copyText };
}

const attachButton = () => screen.queryByRole('button', { name: 'צירוף קובץ' });
const sheet = (name = 'דף עבודה.pdf') => new File(['%PDF-1.7'], name, { type: 'application/pdf' });
const photoFile = (name = 'IMG_0042.jpg') => new File(['x'], name, { type: 'image/jpeg' });

async function attach(...files: File[]) {
  await userEvent.upload(screen.getByLabelText('קובץ לצירוף'), files.length > 0 ? files : [sheet()]);
}

/** A file's name as the screen shows it: one element, its start and its type in parts of their own. */
const fileName = (name: string) => (_: string, element: Element | null) => element?.classList.contains('file-name') === true && element.textContent === name;
const chips = () => document.querySelectorAll('.attachment-chip');
const bubble = () => document.querySelector('.bubble') as HTMLElement;
const sentPdf = (number = 1) => ({ kind: 'pdf', bytes: PDF.bytes, number });

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
    expect(await screen.findByText(fileName('דף עבודה.pdf'))).toBeInTheDocument();
    // A message needs words of hers too: the file alone is not sent.
    expect(screen.getByRole('button', { name: 'שליחה' })).toBeDisabled();
    await say('מה כתוב כאן?');

    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe('vision-model');
    expect(requests[0].webSearch).toBe(false);
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'מה כתוב כאן?', files: [sentPdf()] }]);
    // Her name for the file stays on the phone.
    expect(requests[0].messages[0].files?.[0]).not.toHaveProperty('name');
    // The waiting file is gone from the message box, and is shown inside her message.
    expect(screen.queryByRole('button', { name: 'הסרת קובץ 1' })).not.toBeInTheDocument();
    expect(within(bubble()).getByText(fileName('דף עבודה.pdf'))).toBeInTheDocument();
    // The answer is marked with the mode's name and the model that wrote it: the one for files.
    expect(screen.getByText(/^שיחה ·/).textContent).toMatch(/^שיחה · vision-model · /);
  });

  it("sends a file to the files' model in a parent's own use too, and says the child baseline is to be left out", async () => {
    const { requests } = openApp({ parentUse: true });
    await attach();
    await say('what does it say?');
    expect(requests[0]).toMatchObject({ model: 'vision-model', webSearch: false, kidUse: false });
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'what does it say?', files: [sentPdf()] }]);
  });

  it('copies only her words from a message with a file: the file and its name never reach the clipboard', async () => {
    const { copyText } = openApp();
    await attach();
    await say('מה כתוב כאן?');
    await screen.findByText('תשובה');
    await userEvent.click(screen.getByRole('button', { name: 'העתקה של מה שכתבתי' }));
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(copyText).toHaveBeenCalledWith('מה כתוב כאן?');
  });

  it('sends the same file again with a follow-up, and goes back to the mode\'s own model in a new chat', async () => {
    const { requests } = openApp();
    await attach();
    await say('מה כתוב כאן?');
    await say('ושאלה 2?', 2);
    expect(requests[1].model).toBe('vision-model');
    expect(requests[1].messages[0].files).toEqual([sentPdf()]);
    expect(requests[1].messages[2]).toEqual({ role: 'user', content: 'ושאלה 2?' });

    await userEvent.click(screen.getByRole('button', { name: 'שיחה חדשה' }));
    await say('שלום');
    expect(requests[2].model).toBe('chat-model');
    expect(requests[2].messages).toEqual([{ role: 'user', content: 'שלום' }]);
  });

  it('shows a picture she attached inside her message, and over the whole screen when she taps it', async () => {
    openApp({ prepare: async () => PHOTO });
    await attach(photoFile());
    // A picture waits as a small picture with its number, not under the camera's file name.
    expect(await screen.findByText('תמונה 1')).toBeInTheDocument();
    expect(document.querySelector('.attachment-thumb')).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    expect(screen.queryByText('IMG_0042.jpg')).not.toBeInTheDocument();
    await say('מה יש בתמונה?');
    const shown = bubble().querySelector('img');
    expect(shown).toHaveAttribute('alt', 'תמונה 1 שצירפתי');
    expect(shown).toHaveAttribute('src', expect.stringMatching(/^blob:/));

    await userEvent.click(screen.getByRole('button', { name: 'תמונה 1: הגדלה' }));
    const viewer = screen.getByRole('dialog', { name: 'תמונה 1 שצירפתי' });
    expect(within(viewer).getByRole('img', { name: 'תמונה 1 שצירפתי' })).toBeInTheDocument();
    expect(within(viewer).getByRole('button', { name: 'סגירת התמונה' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lets her take the file off before sending', async () => {
    const { requests } = openApp();
    await attach();
    await userEvent.click(await screen.findByRole('button', { name: 'הסרת קובץ 1' }));
    expect(screen.queryByText(fileName('דף עבודה.pdf'))).not.toBeInTheDocument();
    // Focus goes back to the attach button, so she isn't left nowhere.
    expect(attachButton()).toHaveFocus();
    await say('שלום');
    expect(requests[0].model).toBe('chat-model');
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'שלום' }]);
  });

  it.each(['unsupported', 'too-large', 'unreadable'] as const)('tells her in one friendly line when a file cannot be attached (%s), and attaches nothing', async (problem) => {
    const { requests } = openApp({ prepare: () => Promise.reject(new AttachmentError(problem)) });
    await attach();
    expect(await screen.findByText(attachmentMessage(problem))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'הסרת קובץ 1' })).not.toBeInTheDocument();
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
    await screen.findByText(fileName('דף עבודה.pdf'));
    await pick(/חיפוש/);
    expect(screen.queryByText(fileName('דף עבודה.pdf'))).not.toBeInTheDocument();
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
    expect(requests[1].messages.some((message) => message.files !== undefined)).toBe(false);
    expect(requests[1].messages[0]).toEqual({ role: 'user', content: 'מה כתוב כאן?' });
  });

  it('keeps the file with its chat on the phone', async () => {
    const store = memoryStore();
    openApp({ store });
    await attach();
    await say('מה כתוב כאן?');
    await waitFor(() => expect([...store.chats.values()][0]?.messages).toHaveLength(2));
    expect([...store.chats.values()][0].messages[0].attachments).toEqual([PDF]);
  });

  it('asks again with the file on "try again", and never hands it to a search asked again', async () => {
    const { requests } = openApp();
    await attach();
    await say('מה כתוב כאן?');
    await userEvent.click(screen.getByRole('button', { name: 'נסי שוב' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].model).toBe('vision-model');
    expect(requests[1].messages).toEqual([{ role: 'user', content: 'מה כתוב כאן?', files: [sentPdf()] }]);

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
          { id: 'q', role: 'user', text: 'מה כתוב כאן?', at: 1, mode: 'chat', attachments: [PDF] },
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
    expect(requests[0].messages[0]).toEqual({ role: 'user', content: 'מה כתוב כאן?', files: [sentPdf()] });
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
    expect(requests[0].messages[0].files).toBeDefined();

    // Her next message goes without the file, to the mode's own model, and is answered.
    await say('אז בלי הקובץ: מה זה שבר?');
    expect(requests[1].model).toBe('chat-model');
    expect(requests[1].messages.some((message) => message.files !== undefined)).toBe(false);
    // The file is still shown in her message and kept on the phone, marked as refused.
    expect(within(bubble()).getByText(fileName('דף עבודה.pdf'))).toBeInTheDocument();
    await waitFor(() => expect([...store.chats.values()][0]?.messages[0].attachments?.[0].refused).toBe(true));
  });

  it('keeps sending the file after a failure that is not about the file', async () => {
    const { requests } = openApp({ fails: (call) => (call === 1 ? new AiError('network') : null) });
    await attach();
    await userEvent.type(screen.getByLabelText('הודעה'), 'מה כתוב כאן?');
    await userEvent.click(screen.getByRole('button', { name: 'שליחה' }));
    await userEvent.click(await screen.findByRole('button', { name: 'ננסה שוב' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].messages[0].files).toEqual([sentPdf()]);
  });
});

describe('attaching several files', () => {
  /** Each picked file made ready as what its name says: a photo or a PDF, keeping her name for it. */
  const byName = async (file: File): Promise<Attachment> => (file.type.startsWith('image/') ? { ...PHOTO, name: file.name.startsWith('IMG') ? '' : file.name } : { ...PDF, name: file.name });

  it('takes several at once, numbers them, and sends them all with her message in her order', async () => {
    const { requests, smaller } = openApp({ fileModelImages: 5, prepare: byName });
    await attach(photoFile(), sheet('שיעורי בית.pdf'), photoFile('הלוח.jpg'));
    await waitFor(() => expect(chips()).toHaveLength(3));
    expect(screen.getByRole('button', { name: 'הסרת קובץ 3' })).toBeInTheDocument();
    expect(screen.getByText('תמונה 3: הלוח.jpg')).toBeInTheDocument();
    // More than one picture: each is redrawn smaller.
    expect(smaller).toEqual([true, true, true]);
    expect(screen.getByLabelText('הודעה')).toHaveAttribute('placeholder', 'מה לעשות עם הקבצים?');
    await say('מה ההבדל?');

    expect(requests[0].messages).toEqual([
      {
        role: 'user',
        content: 'מה ההבדל?',
        files: [
          { kind: 'image', bytes: PHOTO.bytes, number: 1 },
          sentPdf(2),
          { kind: 'image', bytes: PHOTO.bytes, number: 3 },
        ],
      },
    ]);
    // Her names for the files never leave the phone.
    expect(JSON.stringify(requests[0].messages)).not.toContain('שיעורי בית');
    // In her message: the pictures with their numbers, the document by her name for it.
    expect(bubble().querySelectorAll('img')).toHaveLength(2);
    expect(within(bubble()).getByText(fileName('שיעורי בית.pdf'))).toBeInTheDocument();
  });

  it('redraws a single picture at its full size', async () => {
    const { smaller } = openApp({ fileModelImages: 5, prepare: byName });
    await attach(photoFile(), sheet());
    await waitFor(() => expect(chips()).toHaveLength(2));
    expect(smaller).toEqual([false, false]);
  });

  it('attaches no more pictures than the model for files reads, and says so', async () => {
    const { picked } = openApp({ prepare: byName });
    await attach(photoFile('IMG_1.jpg'), photoFile('IMG_2.jpg'));
    expect(await screen.findByText('צירפתי קובץ אחד מתוך 2. אפשר לצרף רק תמונה אחת להודעה.')).toBeInTheDocument();
    expect(chips()).toHaveLength(1);
    // The second one was not even opened: the message had no room for it.
    expect(picked).toHaveLength(1);
  });

  it('attaches up to 5 documents to one message', async () => {
    openApp({ prepare: byName });
    await attach(...Array.from({ length: 7 }, (_, i) => sheet(`דף ${i + 1}.pdf`)));
    expect(await screen.findByText('צירפתי 5 מתוך 7. אפשר לצרף עד 5 מסמכים להודעה.')).toBeInTheDocument();
    expect(chips()).toHaveLength(5);
    // Full for both kinds: the attach button still answers, with the reason.
    await attach(photoFile());
    expect(chips()).toHaveLength(6);
    await userEvent.click(attachButton()!);
    expect(screen.getByText('אי אפשר לצרף עוד קבצים להודעה הזאת.')).toBeInTheDocument();
    expect(attachButton()).toHaveAttribute('aria-disabled', 'true');
  });

  it('says in one line how many could not be opened, and keeps the others', async () => {
    openApp({ fileModelImages: 5, prepare: async (file) => (file.name.startsWith('bad') ? Promise.reject(new AttachmentError('unreadable')) : byName(file)) });
    await attach(sheet('bad1.pdf'), sheet('good.pdf'), sheet('bad2.pdf'));
    expect(await screen.findByText('צירפתי קובץ אחד מתוך 3. 2 קבצים לא נפתחו.')).toBeInTheDocument();
    expect(chips()).toHaveLength(1);
    expect(screen.getByText(fileName('good.pdf'))).toBeInTheDocument();
  });

  it("doesn't bring back a file she took off while it was being made ready, and can't send until the rest are ready", async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { requests } = openApp({ fileModelImages: 5, prepare: async (file) => (file.name === 'slow.pdf' ? slow.then(() => byName(file)) : byName(file)) });
    await attach(sheet('slow.pdf'), sheet('quick.pdf'));
    await waitFor(() => expect(chips()).toHaveLength(2));
    expect(screen.getByText('מכינה את הקבצים...')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('הודעה'), 'מה כתוב?');
    expect(screen.getByRole('button', { name: 'שליחה' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'הסרת קובץ 1' }));
    release();
    await waitFor(() => expect(screen.getByText(fileName('quick.pdf'))).toBeInTheDocument());
    expect(screen.queryByText(fileName('slow.pdf'))).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'שליחה' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].messages[0].files).toEqual([sentPdf(1)]);
  });

  it('sends all the files of her newest message with files again, as many pictures as the model reads now', async () => {
    const { requests, settings } = openApp({ fileModelImages: 5, prepare: byName });
    await attach(photoFile(), photoFile(), sheet());
    await waitFor(() => expect(chips()).toHaveLength(3));
    await say('מה יש כאן?');
    await say('ועוד שאלה?', 2);
    expect(requests[1].messages[0].files?.map((f) => f.number)).toEqual([1, 2, 3]);

    // The parent picked a model that reads one picture: the second one stays on the phone.
    settings.fileModelImages = 1;
    await say('ועוד אחת?', 3);
    expect(requests[2].messages[0].files?.map((f) => [f.kind, f.number])).toEqual([
      ['image', 1],
      ['pdf', 3],
    ]);
  });

  it('marks every file of the message as refused when the provider would not take them', async () => {
    const store = memoryStore();
    openApp({ store, fileModelImages: 5, prepare: byName, fails: (call) => (call === 1 ? new AiError('bad-request', '400') : null) });
    await attach(photoFile(), sheet());
    await waitFor(() => expect(chips()).toHaveLength(2));
    await userEvent.type(screen.getByLabelText('הודעה'), 'מה כתוב?');
    await userEvent.click(screen.getByRole('button', { name: 'שליחה' }));
    await waitFor(() => expect([...store.chats.values()][0]?.messages[0].attachments?.map((a) => a.refused)).toEqual([true, true]));
  });
});
