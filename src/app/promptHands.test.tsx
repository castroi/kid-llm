import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChatResult, GeneratedImage } from '../ai/providers';
import type { ChatRequest, ImageRequest } from '../ai/send';
import type { ModeId } from '../core/modes';
import type { Settings } from '../storage/settings';
import { memoryStore } from '../test/memoryStore';
import { type Services, useChat } from './useChat';

/*
 * Which written system prompt a call from the chat screen carries: the one for her in her
 * hands, the one for a parent in a parent's own use, and never the other one, whatever
 * happened on the phone between two calls.
 */

const KID = 'KID-ONLY-7f3a: explain with examples from school.';
const ADULT = 'ADULT-ONLY-91c2: answer as to an adult.';

const HERS: Settings = {
  provider: 'venice',
  models: { chat: 'model-chat', search: 'model-search', math: 'model-math', draw: 'model-draw' },
  systemPrompt: KID,
  parentSystemPrompt: ADULT,
  childName: '',
  dailyLimit: null,
};
const PARENTS: Settings = { ...HERS, parentUse: true };

const PICTURE: GeneratedImage = { type: 'image/webp', bytes: new Uint8Array([82, 73, 70, 70]).buffer };

/** The phone and a provider that answers at once. `phone.settings` can change between calls, as a parent changes them. */
function fakeServices(settings: Settings) {
  const requests: ChatRequest[] = [];
  const pictures: ImageRequest[] = [];
  let id = 0;
  const phone = { settings };
  const services: Services = {
    store: memoryStore(),
    loadSettings: () => phone.settings,
    loadApiKey: () => 'sk-test',
    sendChat: async (request): Promise<ChatResult> => {
      requests.push(request);
      request.onDelta('תשובה');
      return { text: 'תשובה', finishReason: 'stop' };
    },
    prepareAttachment: () => Promise.reject(new Error('no files in this test')),
    generateImage: async (request) => {
      pictures.push(request);
      return PICTURE;
    },
    sentToday: () => 0,
    countMessage: () => true,
    now: () => 1_700_000_000_000 + id,
    newId: () => `id-${++id}`,
    copyText: async () => undefined,
  };
  return { services, requests, pictures, phone };
}

function open(settings: Settings) {
  const fake = fakeServices(settings);
  const { result } = renderHook(() => useChat(fake.services));
  const calls = () => fake.requests.length + fake.pictures.length;
  /** Runs one step that makes a call, and waits for its answer to be written. */
  const after = async (step: () => void) => {
    const before = calls();
    act(step);
    await waitFor(() => expect(calls()).toBe(before + 1));
    await waitFor(() => expect(result.current.writing).toBe(false));
  };
  return {
    ...fake,
    result,
    say: (text: string) => after(() => void result.current.send(text)),
    retry: () => after(() => result.current.retry()),
    pick: (mode: ModeId) => act(() => result.current.setMode(mode)),
  };
}

/** A call made for her: her text, no mark of a parent's use, nothing of a parent's text anywhere in it. */
function expectHers(request: ChatRequest, text = KID) {
  expect(request.systemPrompt).toBe(text);
  expect(request).not.toHaveProperty('kidUse');
  expect(request).not.toHaveProperty('parentSystemPrompt');
  expect(JSON.stringify(request)).not.toContain('ADULT-ONLY');
}

/** A call made in a parent's own use: the parent's text with the mark, nothing of her text anywhere in it. */
function expectParents(request: ChatRequest, text = ADULT) {
  expect(request.kidUse).toBe(false);
  expect(request.parentSystemPrompt).toBe(text);
  expect(request.systemPrompt).toBe('');
  expect(JSON.stringify(request)).not.toContain('KID-ONLY');
}

const CHAT_MODES: ModeId[] = ['chat', 'search', 'math'];

describe('the written system prompt of a call from the chat screen', () => {
  it('is the one written for her, in every mode, while the app is used by a child', async () => {
    const app = open(HERS);
    for (const mode of CHAT_MODES) {
      app.pick(mode);
      await app.say(`שאלה במצב ${mode}`);
    }
    expect(app.requests).toHaveLength(CHAT_MODES.length);
    expect(app.requests.map((request) => request.webSearch)).toEqual([false, true, false]);
    for (const request of app.requests) expectHers(request);
  });

  it("is the one written for a parent, in every mode, in a parent's own use", async () => {
    const app = open(PARENTS);
    for (const mode of CHAT_MODES) {
      app.pick(mode);
      await app.say(`שאלה במצב ${mode}`);
    }
    expect(app.requests).toHaveLength(CHAT_MODES.length);
    expect(app.requests.map((request) => request.webSearch)).toEqual([false, true, false]);
    for (const request of app.requests) expectParents(request);
  });

  it('follows the phone from one message to the next, and never carries both', async () => {
    const app = open(HERS);
    await app.say('אחת');
    app.phone.settings = PARENTS;
    await app.say('שתיים');
    app.phone.settings = HERS;
    await app.say('שלוש');
    app.phone.settings = PARENTS;
    await app.say('ארבע');
    expectHers(app.requests[0]);
    expectParents(app.requests[1]);
    expectHers(app.requests[2]);
    expectParents(app.requests[3]);
  });

  it("sends a parent's text, not hers, when a parent asks again for an answer in a chat she started", async () => {
    const app = open(HERS);
    await app.say('למה השמיים כחולים?');
    expectHers(app.requests[0]);
    app.phone.settings = PARENTS;
    await app.retry();
    expectParents(app.requests[1]);
    // Her words of the chat are sent again; the instructions written for her are not.
    expect(app.requests[1].messages).toEqual([{ role: 'user', content: 'למה השמיים כחולים?' }]);
  });

  it("sends her text, not a parent's, when she asks again for an answer in a chat a parent started", async () => {
    const app = open(PARENTS);
    await app.say('question');
    expectParents(app.requests[0]);
    app.phone.settings = HERS;
    await app.retry();
    expectHers(app.requests[1]);
  });

  it('takes each text as it is saved at the moment of the call', async () => {
    const app = open(HERS);
    await app.say('אחת');
    app.phone.settings = { ...HERS, systemPrompt: 'KID-ONLY new words', parentSystemPrompt: 'ADULT-ONLY new words' };
    await app.say('שתיים');
    expectHers(app.requests[1], 'KID-ONLY new words');
    app.phone.settings = { ...PARENTS, systemPrompt: 'KID-ONLY newer words', parentSystemPrompt: 'ADULT-ONLY newer words' };
    await app.say('שלוש');
    expectParents(app.requests[2], 'ADULT-ONLY newer words');
  });

  it('sends nothing written, rather than the other text, when the side that holds the app has none', async () => {
    const hers = open({ ...HERS, systemPrompt: '' });
    await hers.say('שלום');
    expectHers(hers.requests[0], '');

    const { parentSystemPrompt: _none, ...noParentText } = PARENTS;
    expect(_none).toBe(ADULT);
    const parents = open(noParentText);
    await parents.say('hello');
    expectParents(parents.requests[0], '');
  });

  it("counts a phone whose saved switch is anything but exactly `true` as hers", async () => {
    for (const parentUse of ['true', 1, 'yes', {}, [], null, false, 0]) {
      const app = open({ ...HERS, parentUse } as unknown as Settings);
      await app.say('שלום');
      expectHers(app.requests[0]);
    }
  });

  it('sends neither text with a picture request, whoever holds the app', async () => {
    for (const settings of [HERS, PARENTS]) {
      const app = open(settings);
      app.pick('draw');
      await app.say('חתול על הירח');
      expect(app.requests).toHaveLength(0);
      expect(app.pictures).toHaveLength(1);
      expect(app.pictures[0].prompt).toBe('חתול על הירח');
      const sent = JSON.stringify(app.pictures[0]);
      expect(sent).not.toContain('KID-ONLY');
      expect(sent).not.toContain('ADULT-ONLY');
    }
  });
});
