import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatResult } from '../ai/providers';
import type { ChatRequest } from '../ai/send';
import { UPDATE_MESSAGE } from '../core/kidMessages';
import type { Settings } from '../storage/settings';
import { fakeParent } from '../test/fakeParent';
import { App } from './App';
import type { Services } from './useChat';
import { UPDATE_CHECK_INTERVAL_MS, type UpdateServices } from './useUpdateCheck';

const THIS_BUILD = '1111111111111111111111111111111111111111';
const NEWER = '2222222222222222222222222222222222222222';
const NEWEST = '3333333333333333333333333333333333333333';

const SETTINGS: Settings = {
  provider: 'venice',
  models: { chat: 'model-chat', search: 'model-search', math: 'model-math', draw: 'model-draw' },
  systemPrompt: '',
  childName: '',
  dailyLimit: null,
};

function services(sendChat: (request: ChatRequest) => Promise<ChatResult>): Services {
  let id = 0;
  return {
    store: null,
    loadSettings: () => SETTINGS,
    loadApiKey: () => 'sk-test',
    sendChat,
    prepareAttachment: () => Promise.reject(new Error('no files in this test')),
    generateImage: () => Promise.reject(new Error('no drawing in this test')),
    sentToday: () => 0,
    countMessage: () => true,
    now: () => 1_700_000_000_000 + id,
    newId: () => `id-${++id}`,
    copyText: async () => undefined,
  };
}

interface Site {
  /** What the site says it serves now. */
  deployed: string | null;
  online: boolean;
}

function open(site: Partial<Site> = {}, options: { current?: string; sendChat?: (request: ChatRequest) => Promise<ChatResult> } = {}) {
  const state: Site = { deployed: THIS_BUILD, online: true, ...site };
  const deployed = vi.fn(async () => state.deployed);
  const reload = vi.fn();
  const updates: UpdateServices = { current: options.current ?? THIS_BUILD, deployed, reload, isOnline: () => state.online };
  const send =
    options.sendChat ??
    (async (request: ChatRequest): Promise<ChatResult> => {
      request.onDelta('היי');
      return { text: 'היי', finishReason: 'stop' };
    });
  const { unmount } = render(<App services={services(send)} parent={fakeParent().parent} updates={updates} />);
  return { state, deployed, reload, unmount };
}

const notice = () => screen.queryByText(UPDATE_MESSAGE);

function show(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => void document.dispatchEvent(new Event('visibilitychange')));
}

/** Lets everything already started settle, to show that nothing more happens. */
const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('the update notice', () => {
  it('says so when the site serves a newer version, with a way to load it now or later', async () => {
    open({ deployed: NEWER });
    expect(await screen.findByText(UPDATE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'לעדכן' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'אחר כך' })).toBeInTheDocument();
  });

  it('says nothing while the site serves this same version', async () => {
    const { deployed } = open({ deployed: THIS_BUILD });
    await waitFor(() => expect(deployed).toHaveBeenCalled());
    await settle();
    expect(notice()).toBeNull();
  });

  it('says nothing when the site cannot tell which version it serves', async () => {
    const { deployed } = open({ deployed: null });
    await waitFor(() => expect(deployed).toHaveBeenCalled());
    await settle();
    expect(notice()).toBeNull();
  });

  it.each(['', 'dev', THIS_BUILD.slice(0, 7)])('never asks when the build does not know its own commit: %j', async (current) => {
    const { deployed } = open({ deployed: NEWER }, { current });
    show('visible');
    await settle();
    expect(deployed).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
  });

  it('never asks while the app is without a connection, and asks once it is back online', async () => {
    const { state, deployed } = open({ deployed: NEWER, online: false });
    show('visible');
    await settle();
    expect(deployed).not.toHaveBeenCalled();

    state.online = true;
    act(() => void window.dispatchEvent(new Event('online')));
    expect(await screen.findByText(UPDATE_MESSAGE)).toBeInTheDocument();
  });

  it('asks again each time the app comes back to the screen, and not while it is off it', async () => {
    const { state, deployed } = open({ deployed: THIS_BUILD });
    await waitFor(() => expect(deployed).toHaveBeenCalledTimes(1));

    state.deployed = NEWER;
    show('hidden');
    await settle();
    expect(deployed).toHaveBeenCalledTimes(1);

    show('visible');
    expect(await screen.findByText(UPDATE_MESSAGE)).toBeInTheDocument();
    expect(deployed).toHaveBeenCalledTimes(2);
  });

  it('asks again every hour while the app stays open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { state, deployed } = open({ deployed: THIS_BUILD });
    await waitFor(() => expect(deployed).toHaveBeenCalledTimes(1));

    state.deployed = NEWER;
    act(() => void vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS - 1));
    expect(deployed).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(1));
    expect(await screen.findByText(UPDATE_MESSAGE)).toBeInTheDocument();
    expect(deployed).toHaveBeenCalledTimes(2);
  });

  it('asks one question at a time', async () => {
    let answer: (commit: string | null) => void = () => undefined;
    const { deployed } = open();
    await waitFor(() => expect(deployed).toHaveBeenCalledTimes(1));
    await settle();
    deployed.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    show('visible');
    show('visible');
    show('visible');
    // The first ask, when the app opened, answered already; one more is waiting.
    expect(deployed).toHaveBeenCalledTimes(2);
    answer(NEWER);
    expect(await screen.findByText(UPDATE_MESSAGE)).toBeInTheDocument();
  });

  it('"לעדכן" loads the new version', async () => {
    const { reload } = open({ deployed: NEWER });
    await userEvent.click(await screen.findByRole('button', { name: 'לעדכן' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('"אחר כך" puts it off until a version newer still is out', async () => {
    const { state, reload } = open({ deployed: NEWER });
    await userEvent.click(await screen.findByRole('button', { name: 'אחר כך' }));
    expect(notice()).toBeNull();
    expect(reload).not.toHaveBeenCalled();

    // The same version again: still put off.
    show('visible');
    await settle();
    expect(notice()).toBeNull();

    state.deployed = NEWEST;
    show('visible');
    expect(await screen.findByText(UPDATE_MESSAGE)).toBeInTheDocument();
  });

  it('is never shown while an answer is being written, so loading the new version cannot cut it', async () => {
    let finish: () => void = () => undefined;
    const sendChat = (request: ChatRequest) =>
      new Promise<ChatResult>((resolve) => {
        request.onDelta('חצי ');
        finish = () => resolve({ text: 'חצי תשובה', finishReason: 'stop' });
      });
    const { state } = open({ deployed: THIS_BUILD }, { sendChat });
    await userEvent.type(screen.getByLabelText('הודעה'), 'שלום');
    await userEvent.click(screen.getByRole('button', { name: 'שליחה' }));

    state.deployed = NEWER;
    show('visible');
    await settle();
    expect(notice()).toBeNull();

    act(() => finish());
    expect(await screen.findByText(UPDATE_MESSAGE)).toBeInTheDocument();
  });

  it('stops asking once the screen is gone', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { deployed, unmount } = open();
    await waitFor(() => expect(deployed).toHaveBeenCalledTimes(1));
    unmount();
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS * 3);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    expect(deployed).toHaveBeenCalledTimes(1);
  });
});

describe('the app without an update check', () => {
  it('works as before when none is given (tests, and builds that run without one)', async () => {
    render(<App services={services(async () => ({ text: '', finishReason: 'stop' }))} parent={fakeParent().parent} />);
    show('visible');
    await settle();
    expect(notice()).toBeNull();
  });
});
