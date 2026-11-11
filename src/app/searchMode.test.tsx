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
});
