// @vitest-environment node
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { base64, enclaveDecrypt, enclaveEncrypt, fakeQuote } from '../test/enclave';
import { AI_PROVIDERS } from './catalog';
import { ADAPTERS, AiError, encryptedRequestProblem, MAX_ATTESTATION_BODY_CHARS, type FetchLike } from './providers';
import { sendChat, type ChatRequest } from './send';

const KEY = 'sk-test-secret';
const MODEL = 'private-model-1';
const ATTESTATION = AI_PROVIDERS.venice.endpoints.attestation;
const CHAT = AI_PROVIDERS.venice.endpoints.chat;
const encoder = new TextEncoder();

interface Sent {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body?: { model: string; messages: { role: string; content: unknown }[]; venice_parameters?: Record<string, unknown> };
}

type Report = Record<string, unknown>;

/** The attestation without one of its fields. */
function without(report: Report, field: string): Report {
  const copy = { ...report };
  delete copy[field];
  return copy;
}

interface VeniceOptions {
  /** Changes the attestation before it is sent; gets the nonce that was asked with. */
  attestation?: (good: Report, nonce: string) => unknown;
  attestationStatus?: number;
  /** A raw attestation body instead of JSON. */
  attestationBody?: string;
  /** The connection breaks while the attestation is read. */
  attestationBreaks?: boolean;
  /** The chat call is refused with this status. */
  chatStatus?: number;
  /** The answer's pieces: text is encrypted to the client's key, `{ plain }` is sent as it is. */
  answer?: (string | { plain: string } | { raw: string } | { tampered: string })[];
}

/** Venice and its enclave, as far as these calls go. */
function fakeVenice(options: VeniceOptions = {}) {
  const enclave = secp256k1.utils.randomSecretKey();
  const enclavePublic = bytesToHex(secp256k1.getPublicKey(enclave, false));
  const sent: Sent[] = [];
  const fetch: FetchLike = (url, init) => {
    const headers = { ...(init.headers as Record<string, string>) };
    const entry: Sent = { url, init, headers, ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) as Sent['body'] } : {}) };
    sent.push(entry);
    if (url.startsWith(`${ATTESTATION}?`)) {
      const nonce = new URL(url).searchParams.get('nonce') ?? '';
      const good: Report = {
        verified: true,
        nonce,
        model: new URL(url).searchParams.get('model'),
        tee_provider: 'test',
        intel_quote: base64(fakeQuote()),
        signing_key: enclavePublic,
        signing_address: '0x0000000000000000000000000000000000000000',
      };
      if (options.attestationBreaks) {
        const broken = new ReadableStream<Uint8Array>({ pull: (controller) => controller.error(new TypeError('Load failed')) });
        return Promise.resolve(new Response(broken, { status: 200 }));
      }
      const body = options.attestationBody ?? JSON.stringify(options.attestation ? options.attestation(good, nonce) : good);
      return Promise.resolve(new Response(body, { status: options.attestationStatus ?? 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (options.chatStatus) return Promise.resolve(new Response(JSON.stringify({ error: 'Encrypted field is not valid hex' }), { status: options.chatStatus }));
    const client = headers['X-Venice-TEE-Client-Pub-Key'];
    const pieces = (options.answer ?? ['שלום ', 'לך!']).map((part) => {
      let content: string;
      if (typeof part === 'string') content = client ? enclaveEncrypt(client, part) : part;
      else if ('plain' in part) content = part.plain;
      else if ('raw' in part) content = part.raw;
      else {
        // Encrypted to the right key, then one byte of the tag changed.
        const sealed = enclaveEncrypt(client, part.tampered);
        content = sealed.slice(0, -2) + (sealed.endsWith('00') ? '01' : '00');
      }
      return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;
    });
    return Promise.resolve(new Response(encoder.encode([...pieces, 'data: [DONE]\n\n'].join('')), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  };
  return { fetch, sent, enclave, enclavePublic, chatCalls: () => sent.filter((call) => call.url === CHAT) };
}

function request(fetch: FetchLike, extra: Partial<ChatRequest> = {}): ChatRequest & { deltas: string[] } {
  const deltas: string[] = [];
  return {
    provider: 'venice',
    model: MODEL,
    systemPrompt: 'Answer in simple Hebrew.',
    messages: [
      { role: 'user', content: 'כמה זה 3+5?' },
      { role: 'assistant', content: '8' },
      { role: 'user', content: 'ועוד 2?' },
    ],
    apiKey: KEY,
    e2ee: true,
    onDelta: (text) => deltas.push(text),
    fetch,
    deltas,
    ...extra,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<AiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AiError);
  return err as AiError;
}

const TEE_HEADERS = ['X-Venice-TEE-Client-Pub-Key', 'X-Venice-TEE-Model-Pub-Key', 'X-Venice-TEE-Signing-Algo'];

describe('a model the list tags E2EE', () => {
  it('checks the attestation first, with the model and a fresh 32-byte nonce, carrying the key and nothing of hers', async () => {
    const venice = fakeVenice();
    await sendChat(request(venice.fetch));
    expect(venice.sent.map((call) => call.url.split('?')[0])).toEqual([ATTESTATION, CHAT]);
    const asked = new URL(venice.sent[0].url);
    expect([...asked.searchParams.keys()]).toEqual(['model', 'nonce']);
    expect(asked.searchParams.get('model')).toBe(MODEL);
    expect(asked.searchParams.get('nonce')).toMatch(/^[0-9a-f]{64}$/);
    expect(venice.sent[0].init.method).toBe('GET');
    expect(venice.sent[0].headers).toEqual({ Authorization: `Bearer ${KEY}` });
    expect(venice.sent[0].init.body).toBeUndefined();
    expect(venice.sent[0].init.redirect).toBe('error');
  });

  it("sends the three E2EE headers, with this call's key and the attested model key", async () => {
    const venice = fakeVenice();
    await sendChat(request(venice.fetch));
    const [chat] = venice.chatCalls();
    expect(chat.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(chat.headers['X-Venice-TEE-Client-Pub-Key']).toMatch(/^04[0-9a-f]{128}$/);
    expect(chat.headers['X-Venice-TEE-Model-Pub-Key']).toBe(venice.enclavePublic);
    expect(chat.headers['X-Venice-TEE-Signing-Algo']).toBe('ecdsa');
  });

  it('encrypts every system and user message so only the enclave reads them; earlier answers go as they are', async () => {
    const venice = fakeVenice();
    await sendChat(request(venice.fetch));
    const body = venice.chatCalls()[0].body!;
    expect(body.model).toBe(MODEL);
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    const [system, first, answer, second] = body.messages;
    expect(enclaveDecrypt(venice.enclave, system.content as string)).toContain('Answer in simple Hebrew.');
    expect(enclaveDecrypt(venice.enclave, first.content as string)).toBe('כמה זה 3+5?');
    expect(answer.content).toBe('8');
    expect(enclaveDecrypt(venice.enclave, second.content as string)).toBe('ועוד 2?');
    // Nothing she or the parent wrote is readable in the request.
    const wire = venice.chatCalls()[0].init.body as string;
    for (const words of ['כמה זה', 'ועוד 2', 'Answer in simple Hebrew']) expect(wire).not.toContain(words);
    expect(body.venice_parameters).toEqual({ include_venice_system_prompt: false });
  });

  it('decrypts the answer piece by piece', async () => {
    const venice = fakeVenice({ answer: ['זה ', '10', '.'] });
    const req = request(venice.fetch);
    const result = await sendChat(req);
    expect(req.deltas).toEqual(['זה ', '10', '.']);
    expect(result.text).toBe('זה 10.');
  });

  it('uses a new key pair and a new nonce for every call', async () => {
    const venice = fakeVenice();
    await sendChat(request(venice.fetch));
    await sendChat(request(venice.fetch));
    const [a, b] = venice.chatCalls();
    expect(a.headers['X-Venice-TEE-Client-Pub-Key']).not.toBe(b.headers['X-Venice-TEE-Client-Pub-Key']);
    const nonces = venice.sent.filter((call) => call.url.startsWith(ATTESTATION)).map((call) => new URL(call.url).searchParams.get('nonce'));
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it('takes the key under its other name and without the 04 prefix, and sends it on as the attestation gave it', async () => {
    const venice = fakeVenice({ attestation: (good) => ({ ...without(good, 'signing_key'), signing_public_key: (good.signing_key as string).slice(2) }) });
    await sendChat(request(venice.fetch));
    const [chat] = venice.chatCalls();
    // The header as in the docs' example: the attestation's value itself.
    expect(chat.headers['X-Venice-TEE-Model-Pub-Key']).toBe(venice.enclavePublic.slice(2));
    // The messages are still encrypted to the full key.
    expect(enclaveDecrypt(venice.enclave, chat.body!.messages[1].content as string)).toBe('כמה זה 3+5?');
  });

  it('accepts the attestation for the same model named in another letter case', async () => {
    const venice = fakeVenice({ attestation: (good) => ({ ...good, model: MODEL }) });
    await sendChat(request(venice.fetch, { model: MODEL.toUpperCase() }));
    expect(venice.chatCalls()).toHaveLength(1);
  });
});

describe('an attestation that does not pass sends nothing of hers', () => {
  const cases: [string, VeniceOptions['attestation']][] = [
    ["Venice's own check failed", (good) => ({ ...good, verified: false })],
    ['no verdict at all', (good) => without(good, 'verified')],
    ['the nonce is not the one asked with', (good) => ({ ...good, nonce: 'ab'.repeat(32) })],
    ['no nonce', (good) => without(good, 'nonce')],
    ['it is for another model', (good) => ({ ...good, model: 'other-model' })],
    ['the enclave is in debug mode', (good) => ({ ...good, intel_quote: base64(fakeQuote({ debug: true })) })],
    ['no TDX quote to check', (good) => without(good, 'intel_quote')],
    ['no model key', (good) => without(good, 'signing_key')],
    ['a model key that is not a point on the curve', (good) => ({ ...good, signing_key: `04${'1'.repeat(128)}` })],
    ['not an object', () => [1, 2]],
  ];
  it.each(cases)('%s', async (_name: string, attestation: VeniceOptions['attestation']) => {
    const venice = fakeVenice({ attestation });
    const err = await failureOf(sendChat(request(venice.fetch)));
    expect(err.reason).toBe('not-verified');
    expect(venice.chatCalls()).toHaveLength(0);
  });

  it('an answer that is not JSON, or far too long', async () => {
    for (const attestationBody of ['<html>', `"${'a'.repeat(MAX_ATTESTATION_BODY_CHARS + 10)}"`]) {
      const venice = fakeVenice({ attestationBody });
      expect((await failureOf(sendChat(request(venice.fetch)))).reason).toBe('not-verified');
      expect(venice.chatCalls()).toHaveLength(0);
    }
  });

  it('a refused key, reported as such and without the key', async () => {
    const venice = fakeVenice({ attestationStatus: 401, attestationBody: JSON.stringify({ error: `bad key ${KEY}` }) });
    const err = await failureOf(sendChat(request(venice.fetch)));
    expect(err.reason).toBe('unauthorized');
    expect(err.detail).not.toContain(KEY);
    expect(venice.chatCalls()).toHaveLength(0);
  });
});

describe('other failures on the E2EE path', () => {
  it('a connection that breaks while the attestation is read is a network failure, and nothing is sent', async () => {
    const venice = fakeVenice({ attestationBreaks: true });
    expect((await failureOf(sendChat(request(venice.fetch)))).reason).toBe('network');
    expect(venice.chatCalls()).toHaveLength(0);
  });

  it('her stop during the attestation is a stop, and nothing is sent', async () => {
    const stop = new AbortController();
    const venice = fakeVenice();
    const stopping: FetchLike = (url, init) => {
      stop.abort();
      return venice.fetch(url, init);
    };
    expect((await failureOf(sendChat(request(stopping, { signal: stop.signal })))).reason).toBe('cancelled');
    expect(venice.chatCalls()).toHaveLength(0);
  });

  it("the provider's refusal of the encrypted call is reported with its message", async () => {
    const venice = fakeVenice({ chatStatus: 400 });
    const err = await failureOf(sendChat(request(venice.fetch)));
    expect(err.reason).toBe('bad-request');
    expect(err.detail).toBe('400 Encrypted field is not valid hex');
  });
});

describe('an E2EE answer that is not what the enclave wrote', () => {
  it('ends the call at a piece that is not encrypted: only the holder of the attested key may write to her', async () => {
    const venice = fakeVenice({ answer: ['שלום ', { plain: 'injected text' }] });
    const req = request(venice.fetch);
    const err = await failureOf(sendChat(req));
    expect(err.reason).toBe('bad-response');
    expect(req.deltas).toEqual(['שלום ']);
  });

  it('ends the call at a piece encrypted to her key whose tag was changed', async () => {
    const venice = fakeVenice({ answer: ['שלום ', { tampered: 'לך' }] });
    const req = request(venice.fetch);
    const err = await failureOf(sendChat(req));
    expect(err.reason).toBe('bad-response');
    expect(err.detail).toBe('a piece of the answer could not be decrypted');
    expect(req.deltas).toEqual(['שלום ']);
  });

  it('ends the call at a piece that does not decrypt, and says why without the contents', async () => {
    const venice = fakeVenice({ answer: [{ raw: 'ab'.repeat(120) }] });
    const err = await failureOf(sendChat(request(venice.fetch)));
    expect(err.reason).toBe('bad-response');
    expect(err.detail).toBe('a piece of the answer could not be decrypted');
  });
});

describe('when E2EE is not used', () => {
  it('a model with no E2EE tag gets the ordinary call: no attestation, no TEE headers, plain text', async () => {
    const venice = fakeVenice({ answer: [{ plain: 'היי' }] });
    await sendChat(request(venice.fetch, { e2ee: undefined }));
    expect(venice.sent.map((call) => call.url)).toEqual([CHAT]);
    const [chat] = venice.chatCalls();
    for (const name of TEE_HEADERS) expect(chat.headers).not.toHaveProperty(name);
    expect(chat.body!.messages[1]).toEqual({ role: 'user', content: 'כמה זה 3+5?' });
  });

  it('a name that looks like an E2EE model changes nothing without the tag', async () => {
    const venice = fakeVenice({ answer: [{ plain: 'היי' }] });
    await sendChat(request(venice.fetch, { model: 'e2ee-qwen3-6-35b-a3b', e2ee: false }));
    expect(venice.sent.map((call) => call.url)).toEqual([CHAT]);
    for (const name of TEE_HEADERS) expect(venice.chatCalls()[0].headers).not.toHaveProperty(name);
  });

  it('search mode goes as an ordinary call even to an E2EE model: Venice disables web search with E2EE', async () => {
    const venice = fakeVenice({ answer: [{ plain: 'מצאתי' }] });
    await sendChat(request(venice.fetch, { webSearch: true }));
    expect(venice.sent.map((call) => call.url)).toEqual([CHAT]);
    expect(venice.chatCalls()[0].body!.venice_parameters).toMatchObject({ enable_web_search: 'on' });
  });

  it('a call that carries a file goes as an ordinary call: Venice takes no files with E2EE', async () => {
    const venice = fakeVenice({ answer: [{ plain: 'תמונה יפה' }] });
    const file = { kind: 'image' as const, bytes: new Uint8Array([0xff, 0xd8, 0xff]).buffer };
    await sendChat(request(venice.fetch, { messages: [{ role: 'user', content: 'מה בתמונה?', file }] }));
    expect(venice.sent.map((call) => call.url)).toEqual([CHAT]);
  });

  it('the adapter itself refuses to encrypt a search or a file, rather than sending them in plain text', async () => {
    const venice = fakeVenice();
    const base = { model: MODEL, systemPrompt: '', apiKey: KEY, signal: new AbortController().signal, fetch: venice.fetch, onDelta: () => undefined, onAlive: () => undefined, e2ee: true };
    const search = await failureOf(ADAPTERS.venice.streamChat({ ...base, webSearch: true, messages: [{ role: 'user', content: 'x' }] }));
    expect(search.reason).toBe('bad-request');
    const file = { kind: 'pdf' as const, bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer };
    const withFile = await failureOf(ADAPTERS.venice.streamChat({ ...base, webSearch: false, messages: [{ role: 'user', content: 'x', file }] }));
    expect(withFile.reason).toBe('bad-request');
    expect(venice.sent).toHaveLength(0);
  });
});

describe('the check just before an encrypted call leaves', () => {
  const enclavePublic = bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false));
  const client = bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false));
  const good = { 'X-Venice-TEE-Client-Pub-Key': client, 'X-Venice-TEE-Model-Pub-Key': enclavePublic, 'X-Venice-TEE-Signing-Algo': 'ecdsa' };
  const sealed = enclaveEncrypt(enclavePublic, 'x');
  const messages = [
    { role: 'system', content: sealed },
    { role: 'user', content: sealed },
    { role: 'assistant', content: '8' },
  ];

  it('passes a call with the three headers and every system and user message encrypted', () => {
    expect(encryptedRequestProblem(good, messages)).toBeNull();
    // The key without its 04, as an attestation may give it.
    expect(encryptedRequestProblem({ ...good, 'X-Venice-TEE-Model-Pub-Key': enclavePublic.slice(2) }, messages)).toBeNull();
  });

  it.each(TEE_HEADERS)('stops a call without %s', (name: string) => {
    const headers: Record<string, string> = { ...good };
    delete headers[name];
    expect(encryptedRequestProblem(headers, messages)).not.toBeNull();
  });

  it('stops a call with a wrong header value', () => {
    expect(encryptedRequestProblem({ ...good, 'X-Venice-TEE-Client-Pub-Key': client.slice(2) }, messages)).toBe('no valid client key header');
    expect(encryptedRequestProblem({ ...good, 'X-Venice-TEE-Model-Pub-Key': 'abc' }, messages)).toBe('no valid model key header');
    expect(encryptedRequestProblem({ ...good, 'X-Venice-TEE-Signing-Algo': 'none' }, messages)).toBe('no signing algorithm header');
  });

  it('stops a call with a system or user message in plain text', () => {
    expect(encryptedRequestProblem(good, [...messages, { role: 'user', content: 'כמה זה 3+5?' }])).toBe('a user message that is not encrypted');
    expect(encryptedRequestProblem(good, [{ role: 'system', content: 'Be kind.' }])).toBe('a system message that is not encrypted');
    expect(encryptedRequestProblem(good, [{ role: 'user', content: [{ type: 'text', text: 'x' }] }])).toBe('a user message that is not encrypted');
  });
});
