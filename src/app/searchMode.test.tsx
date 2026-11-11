import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '../ai/send';
import { SETUP_MESSAGE } from '../core/kidMessages';
import { fakeParent } from '../test/fakeParent';
import { App } from './App';
import type { Services } from './useChat';

function openApp(models: { chat: string; search: string; math: string; draw: string }) {
  const requests: ChatRequest[] = [];
  let id = 0;
  const services: Services = {
    store: null,
    loadSettings: () => ({ provider: 'venice', models, systemPrompt: '', childName: '', dailyLimit: null }),
    loadApiKey: () => 'sk-test',
    sendChat: async (request) => {
      requests.push(request);
      request.onDelta('תשובה');
      return { text: 'תשובה', finishReason: 'stop' };
    },
    sentToday: () => 0,
    countMessage: () => true,
    now: () => 1_700_000_000_000 + id,
    newId: () => `id-${++id}`,
    copyText: async () => undefined,
  };
  render(<App services={services} parent={fakeParent().parent} />);
  return requests;
}

async function say(text: string) {
  await userEvent.type(screen.getByLabelText('הודעה'), text);
  await userEvent.click(screen.getByRole('button', { name: 'שליחה' }));
  await screen.findAllByText('תשובה');
}

const MODELS = { chat: 'chat-model', search: 'search-model', math: 'math-model', draw: '' };

/** Once a chat has messages the mode is changed from the chip next to the message box. */
async function pickFromSheet(name: RegExp) {
  await userEvent.click(document.querySelector('.mode-chip') as HTMLElement);
  await userEvent.click(within(screen.getByRole('dialog', { name: 'במה להשתמש עכשיו?' })).getByRole('button', { name }));
}

const pick = (name: RegExp) => userEvent.click(within(screen.getByRole('group', { name: 'מצב' })).getByRole('button', { name }));

describe('search mode', () => {
  it("searches the web with the search mode's own model, and only in that mode", async () => {
    const requests = openApp({ chat: 'chat-model', search: 'search-model', math: 'math-model', draw: '' });
    await pick(/חיפוש/);
    await say('מי המציא את הטלפון?');
    expect(requests[0].model).toBe('search-model');
    expect(requests[0].webSearch).toBe(true);
    // The answer is marked with the mode's name, never the model's.
    expect(screen.getByText(/חיפוש ·/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('search-model');
  });

  it('does not search in plain chat', async () => {
    const requests = openApp({ chat: 'chat-model', search: 'search-model', math: 'math-model', draw: '' });
    await say('שלום');
    expect(requests[0].model).toBe('chat-model');
    expect(requests[0].webSearch).toBe(false);
  });

  it('tells her the mode is not ready when the parent chose no model for it', async () => {
    const requests = openApp({ chat: 'chat-model', search: '', math: 'math-model', draw: '' });
    await pick(/חיפוש/);
    expect(screen.getByText(SETUP_MESSAGE)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('הודעה'), 'מה מזג האוויר?');
    expect(screen.getByRole('button', { name: 'שליחה' })).toBeDisabled();
    expect(requests).toHaveLength(0);
  });

  it('does not search in maths mode', async () => {
    const requests = openApp(MODELS);
    await pick(/חשבון/);
    await say('כמה זה 7 כפול 8?');
    expect(requests[0].model).toBe('math-model');
    expect(requests[0].webSearch).toBe(false);
  });

  it('follows the mode she is in when she switches in the middle of a chat, in both directions', async () => {
    const requests = openApp(MODELS);
    await say('שלום');
    await pickFromSheet(/חיפוש/);
    await say('מי המציא את הטלפון?');
    await pickFromSheet(/שיחה/);
    await say('תודה');
    expect(requests.map((r) => [r.model, r.webSearch])).toEqual([
      ['chat-model', false],
      ['search-model', true],
      ['chat-model', false],
    ]);
  });

  it('hands a search only what she wrote in search mode, not the rest of the chat', async () => {
    const requests = openApp(MODELS);
    await say('הסוד שלי הוא שאני מפחדת מכלבים');
    await pickFromSheet(/חיפוש/);
    await say('מי המציא את הטלפון?');
    expect(requests[1].webSearch).toBe(true);
    expect(requests[1].messages).toEqual([{ role: 'user', content: 'מי המציא את הטלפון?' }]);
    // A follow-up in search mode still carries the search talk so far.
    await say('ומתי?');
    expect(requests[2].messages).toEqual([
      { role: 'user', content: 'מי המציא את הטלפון?' },
      { role: 'assistant', content: 'תשובה' },
      { role: 'user', content: 'ומתי?' },
    ]);
    // Back in plain chat, the whole chat goes, as before.
    await pickFromSheet(/שיחה/);
    await say('תודה');
    expect(requests[3].messages[0]).toEqual({ role: 'user', content: 'הסוד שלי הוא שאני מפחדת מכלבים' });
  });

  it('asks again in the mode her message was written in: "try again" never turns a plain question into a web search', async () => {
    const requests = openApp(MODELS);
    await say('שלום');
    await pickFromSheet(/חיפוש/);
    await userEvent.click(screen.getByRole('button', { name: 'נסי שוב' }));
    await screen.findAllByText('תשובה');
    expect(requests).toHaveLength(2);
    expect(requests[1].model).toBe('chat-model');
    expect(requests[1].webSearch).toBe(false);
  });

  it('asks a search question again as a search, even after she moved to plain chat', async () => {
    const requests = openApp(MODELS);
    await pick(/חיפוש/);
    await say('מי המציא את הטלפון?');
    await pickFromSheet(/שיחה/);
    await userEvent.click(screen.getByRole('button', { name: 'נסי שוב' }));
    await screen.findAllByText('תשובה');
    expect(requests[1].model).toBe('search-model');
    expect(requests[1].webSearch).toBe(true);
  });
});
