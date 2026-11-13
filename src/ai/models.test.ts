// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { filterModels, looksUncensored, MAX_MODEL_ID_CHARS, MAX_MODEL_NAME_CHARS, MAX_MODELS, modelsFor, priceText, sanitizeModels, type ModelInfo } from './models';

/** One model as Venice's list gives it. */
function entry(id: string, spec: Record<string, unknown> = {}, type = 'text') {
  return { id, object: 'model', owned_by: 'venice.ai', type, model_spec: { name: id.toUpperCase(), privacy: 'private', offline: false, ...spec } };
}

function model(id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return { id, name: id, kind: 'text', privacy: 'private', uncensored: false, tee: false, e2ee: false, webSearch: false, vision: false, price: null, ...extra };
}

describe('sanitizeModels', () => {
  it("keeps a model's name, privacy, tags, abilities and price range, cache prices included", () => {
    const raw = {
      data: [
        entry('deep-flash', {
          name: 'Deep Flash',
          privacy: 'anonymized',
          uncensored: true,
          capabilities: { supportsTeeAttestation: true, supportsE2EE: true, supportsWebSearch: true, supportsVision: true },
          pricing: { input: { usd: 0.15, diem: 0.15 }, output: { usd: 1.25 }, cache_input: { usd: 0.03 }, cache_write: { usd: 0.2 } },
          description: 'never kept',
        }),
      ],
    };
    expect(sanitizeModels(raw, 'text')).toEqual([
      { id: 'deep-flash', name: 'Deep Flash', kind: 'text', privacy: 'anonymized', uncensored: true, tee: true, e2ee: true, webSearch: true, vision: true, price: { min: 0.03, max: 1.25 } },
    ]);
  });

  it('gives a plain model no tags, and no price when the provider sent none or sent something else', () => {
    const [plain, odd] = sanitizeModels({ data: [entry('plain'), entry('odd', { privacy: 'public', uncensored: 'yes', capabilities: 'all', pricing: { input: { usd: '1' }, output: { usd: -1 }, cache_input: { usd: Number.NaN } } })] }, 'text');
    expect(plain).toEqual({ id: 'plain', name: 'PLAIN', kind: 'text', privacy: 'private', uncensored: false, tee: false, e2ee: false, webSearch: false, vision: false, price: null });
    expect(odd).toMatchObject({ privacy: null, uncensored: false, tee: false, webSearch: false, price: null });
  });

  it('leaves out offline models, models of another kind, and repeated names', () => {
    const raw = { data: [entry('on'), entry('off', { offline: true }), entry('picture', {}, 'image'), entry('on', { name: 'again' }), { id: 'untyped', model_spec: {} }] };
    expect(sanitizeModels(raw, 'text').map((m) => m.id)).toEqual(['on', 'untyped']);
    expect(sanitizeModels(raw, 'image').map((m) => m.id)).toEqual(['picture', 'untyped']);
  });

  it('gives an image model no token price', () => {
    const [picture] = sanitizeModels({ data: [entry('picture', { pricing: { input: { usd: 1 } } }, 'image')] }, 'image');
    expect(picture).toMatchObject({ kind: 'image', price: null });
  });

  it('drops an entry whose name could not be a model name in a call', () => {
    const raw = { data: [null, 'text', 7, {}, { id: 5 }, entry(''), entry('has space'), entry('שם'), entry('line\nbreak'), entry('x'.repeat(MAX_MODEL_ID_CHARS + 1)), entry('x'.repeat(MAX_MODEL_ID_CHARS)), entry('ok:v=1.5/b_c')] };
    expect(sanitizeModels(raw, 'text').map((m) => m.id)).toEqual(['x'.repeat(MAX_MODEL_ID_CHARS), 'ok:v=1.5/b_c']);
  });

  it("shows a name without control or direction characters, cut short, and falls back to the call name", () => {
    const raw = {
      data: [
        entry('a', { name: ' Nice\u0000 ‮eman⁦‏؜\u0085 ' }),
        entry('b', { name: 'n'.repeat(MAX_MODEL_NAME_CHARS * 10) }),
        entry('c', { name: 42 }),
        entry('d', { name: '‮\u0007' }),
        { id: 'e' },
      ],
    };
    const [a, b, c, d, e] = sanitizeModels(raw, 'text');
    expect(a.name).toBe('Nice eman');
    expect(b.name).toBe('n'.repeat(MAX_MODEL_NAME_CHARS));
    expect(c.name).toBe('c');
    expect(d.name).toBe('d');
    expect(e).toMatchObject({ id: 'e', name: 'e', privacy: null });
  });

  it('counts a model as uncensored when its name says so, even without the mark', () => {
    const [named, marked, neither] = sanitizeModels({ data: [entry('e2ee-deep-flash-Abliterated'), entry('quiet', { uncensored: true }), entry('quiet-2')] }, 'text');
    expect(named.uncensored).toBe(true);
    expect(marked.uncensored).toBe(true);
    expect(neither.uncensored).toBe(false);
  });

  it('gives an empty list for an answer that is not a list of models, and keeps no more than the most it holds', () => {
    for (const raw of [null, undefined, 'models', 5, [], {}, { data: 'x' }, { data: {} }]) expect(sanitizeModels(raw, 'text')).toEqual([]);
    const many = { data: Array.from({ length: MAX_MODELS + 5 }, (_, n) => entry(`m-${n}`)) };
    expect(sanitizeModels(many, 'text')).toHaveLength(MAX_MODELS);
  });
});

describe('looksUncensored', () => {
  it('reads it from the name, in any letter case', () => {
    expect(looksUncensored('venice-uncensored')).toBe(true);
    expect(looksUncensored('deepseek-v4-1-flash-1017-UNCENSORED')).toBe(true);
    expect(looksUncensored('e2ee-deepseek-abliterated')).toBe(true);
    expect(looksUncensored('llama-3.3-70b')).toBe(false);
    expect(looksUncensored('')).toBe(false);
  });
});

describe('modelsFor', () => {
  const all = [
    model('plain'),
    model('searcher', { webSearch: true }),
    model('reader', { vision: true }),
    model('wild', { uncensored: true, webSearch: true, vision: true }),
    model('painter', { kind: 'image' }),
    model('wild-painter', { kind: 'image', uncensored: true }),
  ];
  const ids = (list: ModelInfo[]) => list.map((m) => m.id);

  it('offers text models for chat and maths, and image models for drawing', () => {
    expect(ids(modelsFor('chat', all, false))).toEqual(['plain', 'searcher', 'reader']);
    expect(ids(modelsFor('math', all, false))).toEqual(['plain', 'searcher', 'reader']);
    expect(ids(modelsFor('draw', all, false))).toEqual(['painter']);
  });

  it('offers search mode only models that search the web, and attached files only models that read pictures', () => {
    expect(ids(modelsFor('search', all, false))).toEqual(['searcher']);
    expect(ids(modelsFor('files', all, false))).toEqual(['reader']);
  });

  it("offers uncensored models only in a parent's own use", () => {
    expect(ids(modelsFor('chat', all, true))).toEqual(['plain', 'searcher', 'reader', 'wild']);
    expect(ids(modelsFor('search', all, true))).toEqual(['searcher', 'wild']);
    expect(ids(modelsFor('files', all, true))).toEqual(['reader', 'wild']);
    expect(ids(modelsFor('draw', all, true))).toEqual(['painter', 'wild-painter']);
  });
});

describe('filterModels', () => {
  const all = [model('deepseek-v4-1-flash', { name: 'DeepSeek V4.1 Flash' }), model('llama-3.3-70b', { name: 'Llama 3.3 70B' }), model('qwen3-vl', { name: 'Qwen 3 VL' })];
  const ids = (typed: string) => filterModels(all, typed).map((m) => m.id);

  it('keeps everything while nothing is typed', () => {
    expect(ids('')).toHaveLength(3);
    expect(ids('   ')).toHaveLength(3);
  });

  it('finds by part of the shown name or of the call name, in any letter case', () => {
    expect(ids('deep')).toEqual(['deepseek-v4-1-flash']);
    expect(ids('LLAMA')).toEqual(['llama-3.3-70b']);
    expect(ids('v4-1')).toEqual(['deepseek-v4-1-flash']);
    expect(ids('70B')).toEqual(['llama-3.3-70b']);
  });

  it('needs every typed word, in any order', () => {
    expect(ids('flash deep')).toEqual(['deepseek-v4-1-flash']);
    expect(ids('deep llama')).toEqual([]);
    expect(ids('nothing-like-it')).toEqual([]);
  });
});

describe('priceText', () => {
  it('shows the range in USD for a million tokens, two digits after the dot', () => {
    expect(priceText({ min: 0.03, max: 1.25 })).toBe('USD 0.03-1.25 / 1M');
    expect(priceText({ min: 0.5, max: 12 })).toBe('USD 0.50-12.00 / 1M');
    expect(priceText({ min: 0, max: 2 })).toBe('USD 0.00-2.00 / 1M');
  });

  it('shows one price when the cheapest and the dearest are the same', () => {
    expect(priceText({ min: 0.6, max: 0.6 })).toBe('USD 0.60 / 1M');
  });

  it('keeps a price under a cent readable instead of rounding it to nothing', () => {
    expect(priceText({ min: 0.0045, max: 0.005 })).toBe('USD 0.0045-0.005 / 1M');
    expect(priceText({ min: 1e-12, max: 1 })).toBe('USD 0.00-1.00 / 1M');
  });
});
