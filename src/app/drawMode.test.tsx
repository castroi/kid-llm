import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AiError, type GeneratedImage } from '../ai/providers';
import type { ChatRequest, ImageRequest } from '../ai/send';
import { kidMessage } from '../core/kidMessages';
import type { ChatStore } from '../storage/chatStore';
import { fakeParent } from '../test/fakeParent';
import { memoryStore } from '../test/memoryStore';
import { App } from './App';
import type { Services } from './useChat';

const PICTURE: GeneratedImage = { type: 'image/webp', bytes: new Uint8Array([82, 73, 70, 70]).buffer };
type Draw = (request: ImageRequest) => Promise<GeneratedImage>;

const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;
beforeAll(() => {
  // jsdom has no picture addresses of its own.
  let made = 0;
  URL.createObjectURL = vi.fn(() => `blob:picture-${++made}`);
  URL.revokeObjectURL = vi.fn();
});
afterAll(() => {
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

function openApp(options: { draw?: Draw; store?: ChatStore | null; dailyLimit?: number | null; drawModel?: string } = {}) {
  const pictures: ImageRequest[] = [];
  const chats: ChatRequest[] = [];
  let sent = 0;
  let id = 0;
  const services: Services = {
    store: options.store ?? null,
    loadSettings: () => ({
      provider: 'venice',
      models: { chat: 'chat-model', search: '', math: '', draw: options.drawModel ?? 'image-model' },
      systemPrompt: 'Be kind.',
      childName: '',
      dailyLimit: options.dailyLimit ?? null,
    }),
    loadApiKey: () => 'sk-test',
    sendChat: async (request) => {
      chats.push(request);
      request.onDelta('תשובה');
      return { text: 'תשובה', finishReason: 'stop' };
    },
    generateImage: (request) => {
      pictures.push(request);
      return (options.draw ?? (async () => PICTURE))(request);
    },
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
  return { pictures, chats, sentNow: () => sent };
}

const pickDraw = () => userEvent.click(within(screen.getByRole('group', { name: 'מצב' })).getByRole('button', { name: /ציור/ }));

async function pickFromSheet(name: RegExp) {
  await userEvent.click(document.querySelector('.mode-chip') as HTMLElement);
  await userEvent.click(within(screen.getByRole('dialog', { name: 'במה להשתמש עכשיו?' })).getByRole('button', { name }));
}

async function ask(text: string) {
  await userEvent.type(screen.getByLabelText('הודעה'), text);
  await userEvent.click(screen.getByRole('button', { name: 'שליחה' }));
}

/** Keeps the call open until it is stopped. */
const hangs: Draw = (request) => new Promise((_, reject) => request.signal?.addEventListener('abort', () => reject(new AiError('cancelled'))));

describe('drawing mode', () => {
  it('makes a picture of what she wrote, with the drawing model, and shows it', async () => {
    const { pictures, chats } = openApp();
    await pickDraw();
    await ask('חתול ג׳ינג׳י על סקייטבורד');
    const picture = await screen.findByRole('img', { name: 'התמונה שציירתי' });
    expect(picture).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    expect(pictures).toHaveLength(1);
    expect(pictures[0]).toMatchObject({ provider: 'venice', model: 'image-model', prompt: 'חתול ג׳ינג׳י על סקייטבורד', apiKey: 'sk-test' });
    // No chat call is made, and nothing else of the settings goes with a picture request.
    expect(chats).toHaveLength(0);
    expect(JSON.stringify(pictures[0])).not.toContain('Be kind.');
    // Marked with the mode's name, never the model's; nothing to copy, but she can ask again.
    expect(screen.getByText(/ציור ·/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('image-model');
    expect(screen.queryByRole('button', { name: 'העתקה' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'נסי שוב' })).toBeInTheDocument();
  });

  it('says it is drawing while she waits, and lets her stop', async () => {
    const { sentNow } = openApp({ draw: hangs });
    await pickDraw();
    await ask('דרקון קטן');
    expect(await screen.findByText('מציירת...')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'עצירה' }));
    await waitFor(() => expect(screen.queryByText('מציירת...')).not.toBeInTheDocument());
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    // Her request stays, with no error: stopping was her choice.
    expect(document.querySelector('.bubble')).toHaveTextContent('דרקון קטן');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(sentNow()).toBe(1);
  });

  it('shows her a kind line, and no picture, when the provider refuses', async () => {
    openApp({ draw: () => Promise.reject(new AiError('refused', 'provider text she must not see')) });
    await pickDraw();
    await ask('משהו לא מתאים');
    expect(await screen.findByText(kidMessage('refused').text)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('provider text');
  });

  it("releases a picture's address when it leaves the screen", async () => {
    openApp();
    await pickDraw();
    await ask('פרח');
    const picture = await screen.findByRole('img', { name: 'התמונה שציירתי' });
    const address = picture.getAttribute('src');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(address);
    await userEvent.click(screen.getByRole('button', { name: 'שיחה חדשה' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(address);
  });

  it('counts a request she stopped once, and the same request sent again once more', async () => {
    let calls = 0;
    const { pictures, sentNow } = openApp({ draw: (request) => (++calls === 1 ? hangs(request) : Promise.resolve(PICTURE)) });
    await pickDraw();
    await ask('פרח');
    await screen.findByText('מציירת...');
    await userEvent.click(screen.getByRole('button', { name: 'עצירה' }));
    await waitFor(() => expect(screen.queryByText('מציירת...')).not.toBeInTheDocument());
    expect(sentNow()).toBe(1);
    // After a stop there is no free "try again": she has to send the request again, and it counts.
    expect(screen.queryByRole('button', { name: 'נסי שוב' })).not.toBeInTheDocument();
    await ask('פרח');
    await screen.findByRole('img');
    expect(pictures).toHaveLength(2);
    expect(sentNow()).toBe(2);
  });

  it('keeps the picture with the chat on the phone', async () => {
    const store = memoryStore();
    openApp({ store });
    await pickDraw();
    await ask('פרח');
    await screen.findByRole('img', { name: 'התמונה שציירתי' });
    await waitFor(() => {
      const saved = [...store.chats.values()][0];
      expect(saved.messages).toHaveLength(2);
      expect(saved.messages[1]).toMatchObject({ role: 'assistant', text: '', mode: 'draw', image: { type: 'image/webp' } });
      expect(new Uint8Array(saved.messages[1].image!.bytes)).toEqual(new Uint8Array([82, 73, 70, 70]));
    });
  });

  it('draws again on "try again", from the same request, and counts the second picture when it arrives', async () => {
    const { pictures, sentNow } = openApp();
    await pickDraw();
    await ask('פרח');
    await screen.findByRole('img');
    expect(sentNow()).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: 'נסי שוב' }));
    await waitFor(() => expect(pictures).toHaveLength(2));
    expect(pictures[1].prompt).toBe('פרח');
    await waitFor(() => expect(sentNow()).toBe(2));
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  it('counts pictures toward the daily limit like messages', async () => {
    const { pictures } = openApp({ dailyLimit: 1 });
    await pickDraw();
    await ask('פרח');
    await screen.findByRole('img');
    await ask('עוד פרח');
    expect(pictures).toHaveLength(1);
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  it('keeps a drawing request out of what a later chat message sends, and draws from her last message only', async () => {
    const { pictures, chats } = openApp();
    await ask('שלום');
    await screen.findByText('תשובה');
    await pickFromSheet(/ציור/);
    await ask('חתול');
    await screen.findByRole('img');
    expect(pictures[0].prompt).toBe('חתול');
    await pickFromSheet(/שיחה/);
    await ask('תודה');
    await waitFor(() => expect(chats).toHaveLength(2));
    expect(chats[1].messages).toEqual([
      { role: 'user', content: 'שלום' },
      { role: 'assistant', content: 'תשובה' },
      { role: 'user', content: 'תודה' },
    ]);
  });

  it('is not available to her when the parent chose no drawing model', async () => {
    const { pictures } = openApp({ drawModel: '' });
    await pickDraw();
    await userEvent.type(screen.getByLabelText('הודעה'), 'פרח');
    expect(screen.getByRole('button', { name: 'שליחה' })).toBeDisabled();
    expect(pictures).toHaveLength(0);
  });
});
