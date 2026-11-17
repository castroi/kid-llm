import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredMessage } from '../core/chat';
import { fakeParent } from '../test/fakeParent';
import { Conversation } from '../ui/Conversation';
import { App } from './App';
import type { Services } from './useChat';

/*
 * On the iPhone the chat could leave the page itself scrolled (the keyboard, or an answer
 * scrolled into view), and the parent area then opened with its top bar ("אזור הורים",
 * "סיום") above the screen. Only the inner scrolling box may move; the page stays at the top.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function openApp() {
  const { parent, phone } = fakeParent();
  let id = 0;
  const services: Services = {
    store: null,
    loadSettings: () => phone.settings,
    loadApiKey: () => phone.apiKey,
    sendChat: () => Promise.reject(new Error('no chat in this test')),
    prepareAttachment: () => Promise.reject(new Error('no files in this test')),
    generateImage: () => Promise.reject(new Error('no drawing in this test')),
    sentToday: () => phone.sent,
    countMessage: () => true,
    now: () => 1_700_000_000_000 + id,
    newId: () => `id-${++id}`,
    copyText: async () => undefined,
  };
  render(<App services={services} parent={parent} />);
}

describe('the page under the screens', () => {
  it('is put back at the top when the parent area opens and when it closes', async () => {
    openApp();
    const scrollTo = vi.spyOn(window, 'scrollTo');

    await userEvent.click(screen.getByRole('button', { name: 'השיחות שלי' }));
    await userEvent.click(screen.getByRole('button', { name: 'אזור הורים' }));
    expect(screen.getByRole('heading', { name: 'אזור הורים' })).toBeInTheDocument();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);

    scrollTo.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'סיום' }));
    expect(screen.getByLabelText('הודעה')).toBeInTheDocument();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });
});

function message(id: string, role: StoredMessage['role'], text: string): StoredMessage {
  return { id, role, text, at: 1_700_000_000_000, mode: 'chat' };
}

function conversation(messages: StoredMessage[]) {
  return (
    <main className="scroll">
      <Conversation messages={messages} writing={false} onRetry={() => undefined} copyText={async () => undefined} />
    </main>
  );
}

describe('the conversation', () => {
  it('keeps the newest message in view by scrolling its own box, never the page', () => {
    // jsdom has no scrollIntoView; given one, it must not be what moves the conversation.
    const scrollIntoView = vi.fn();
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true, writable: true });
    const scrollTo = vi.spyOn(window, 'scrollTo');

    const first = [message('m1', 'user', 'שלום')];
    const { container, rerender } = render(conversation(first));
    const box = container.querySelector('.scroll');
    if (!(box instanceof HTMLElement)) throw new Error('no scrolling box');
    // jsdom lays nothing out: give the box a height of content and record where it is scrolled to.
    let scrolledTo = 0;
    Object.defineProperty(box, 'scrollHeight', { value: 640, configurable: true });
    Object.defineProperty(box, 'scrollTop', {
      configurable: true,
      get: () => scrolledTo,
      set: (value: number) => {
        scrolledTo = value;
      },
    });

    rerender(conversation([...first, message('m2', 'assistant', 'היי!')]));

    expect(scrolledTo).toBe(640);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
    if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
});
