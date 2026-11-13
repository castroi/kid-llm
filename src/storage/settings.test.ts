import { describe, expect, it } from 'vitest';
import {
  apiKeyEntry,
  DEFAULT_SETTINGS,
  loadApiKey,
  loadSettings,
  MAX_DAILY_LIMIT,
  MAX_MODEL_CHARS,
  MAX_NAME_CHARS,
  MAX_SYSTEM_PROMPT_CHARS,
  fileModelFor,
  isUncensored,
  missingFor,
  modelFor,
  sanitizeSettings,
  saveApiKey,
  saveSettings,
  SETTINGS_KEY,
  type Settings,
} from './settings';

/** A phone's storage, in memory. */
function memory(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
  };
}

/** A browser with storage switched off or full. */
const refusing = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('full');
  },
  removeItem: () => {
    throw new Error('denied');
  },
};

const SET_UP: Settings = {
  provider: 'venice',
  models: { chat: 'model-a', search: 'model-b', math: 'model-c', draw: 'model-d' },
  systemPrompt: 'Be kind.',
  childName: 'נועה',
  dailyLimit: 50,
};

describe('settings', () => {
  it('start as defaults: nothing set up, no limit', () => {
    expect(loadSettings(memory())).toEqual(DEFAULT_SETTINGS);
  });

  it('come back as they were saved', () => {
    const storage = memory();
    expect(saveSettings(SET_UP, storage)).toBe(true);
    expect(loadSettings(storage)).toEqual(SET_UP);
  });

  it('never hand out the shared defaults object, so a change in one place cannot leak', () => {
    const loaded = loadSettings(memory());
    loaded.models.chat = 'changed';
    expect(DEFAULT_SETTINGS.models.chat).toBe('');
    expect(loadSettings(refusing).models.chat).toBe('');
  });

  it('fall back to defaults when what is stored cannot be read', () => {
    expect(loadSettings(memory({ [SETTINGS_KEY]: '{not json' }))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(refusing)).toEqual(DEFAULT_SETTINGS);
  });

  it('say so when the browser refuses to save', () => {
    expect(saveSettings(SET_UP, refusing)).toBe(false);
  });

  it('drop unknown fields and wrong types, and cut texts that are too long', () => {
    const clean = sanitizeSettings({
      provider: 'somewhere-else',
      models: { chat: '  model-a  ', search: 7, extra: 'x' },
      systemPrompt: 'x'.repeat(MAX_SYSTEM_PROMPT_CHARS + 50),
      childName: 42,
      dailyLimit: '10',
      apiKey: 'sk-should-not-be-here',
    });
    expect(clean.provider).toBe('venice');
    expect(clean.models).toEqual({ chat: 'model-a', search: '', math: '', draw: '' });
    expect(clean.systemPrompt).toHaveLength(MAX_SYSTEM_PROMPT_CHARS);
    expect(clean.childName).toBe('');
    expect(clean.dailyLimit).toBeNull();
    expect(clean).not.toHaveProperty('apiKey');
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('text')).toEqual(DEFAULT_SETTINGS);
  });

  it('accept only a provider the app knows, not a name every object happens to have', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', '']) {
      expect(sanitizeSettings({ provider: name }).provider).toBe('venice');
    }
    expect(sanitizeSettings(JSON.parse('{"__proto__": {"provider": "x"}, "models": {"__proto__": {"chat": "m"}}}'))).toEqual(DEFAULT_SETTINGS);
  });

  it('never fail, whatever was stored or imported', () => {
    for (const junk of [[], [1, 2], 7, true, { models: [] }, { models: 'x' }, { models: { chat: { deep: 1 } } }, { systemPrompt: {} }, { dailyLimit: {} }, { dailyLimit: NaN }]) {
      expect(sanitizeSettings(junk)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('cut a name and a model name that are too long, without breaking an emoji in half', () => {
    const clean = sanitizeSettings({ childName: 'נ'.repeat(MAX_NAME_CHARS + 10), models: { chat: 'm'.repeat(MAX_MODEL_CHARS + 10) } });
    expect(clean.childName).toHaveLength(MAX_NAME_CHARS);
    expect(clean.models.chat).toHaveLength(MAX_MODEL_CHARS);
    expect(sanitizeSettings({ childName: `${'נ'.repeat(MAX_NAME_CHARS - 1)}😀` }).childName).toBe('נ'.repeat(MAX_NAME_CHARS - 1));
  });

  it('are stored without anything that is not a setting, such as a key pasted into the wrong place', () => {
    const storage = memory();
    saveSettings({ ...SET_UP, apiKey: 'sk-secret' } as Settings, storage);
    expect(storage.entries.get(SETTINGS_KEY)).not.toContain('sk-secret');
  });

  it("are a child's unless a parent's own use was saved as exactly `true`", () => {
    expect(DEFAULT_SETTINGS).not.toHaveProperty('parentUse');
    expect(sanitizeSettings({ parentUse: true }).parentUse).toBe(true);
    for (const junk of [false, 'true', 1, 'yes', {}, [], null, undefined]) {
      expect(sanitizeSettings({ parentUse: junk })).not.toHaveProperty('parentUse');
    }
    // What can't be read at all is a child's phone too.
    expect(loadSettings(memory({ [SETTINGS_KEY]: '{not json' }))).not.toHaveProperty('parentUse');
    expect(loadSettings(memory())).not.toHaveProperty('parentUse');
  });

  it("keep a parent's own use across a save, and forget it when it is switched back", () => {
    const storage = memory();
    saveSettings({ ...SET_UP, parentUse: true }, storage);
    expect(loadSettings(storage).parentUse).toBe(true);
    saveSettings({ ...SET_UP, parentUse: undefined }, storage);
    expect(loadSettings(storage)).not.toHaveProperty('parentUse');
    expect(storage.entries.get(SETTINGS_KEY)).not.toContain('parentUse');
  });

  it('accept a daily limit only as a whole number of at least 1, capped', () => {
    expect(sanitizeSettings({ dailyLimit: 20 }).dailyLimit).toBe(20);
    expect(sanitizeSettings({ dailyLimit: 0 }).dailyLimit).toBeNull();
    expect(sanitizeSettings({ dailyLimit: -5 }).dailyLimit).toBeNull();
    expect(sanitizeSettings({ dailyLimit: 2.5 }).dailyLimit).toBeNull();
    expect(sanitizeSettings({ dailyLimit: 1e9 }).dailyLimit).toBe(MAX_DAILY_LIMIT);
  });
});

describe('the API key', () => {
  it('is kept in its own entry, apart from the settings', () => {
    const storage = memory();
    saveSettings(SET_UP, storage);
    expect(saveApiKey('venice', '  sk-secret\n', storage)).toBe(true);
    expect(loadApiKey('venice', storage)).toBe('sk-secret');
    expect(storage.entries.get(apiKeyEntry('venice'))).toBe('sk-secret');
    expect(storage.entries.get(SETTINGS_KEY)).not.toContain('sk-secret');
  });

  it('is removed when saved empty', () => {
    const storage = memory({ [apiKeyEntry('venice')]: 'sk-secret' });
    saveApiKey('venice', '   ', storage);
    expect(storage.entries.has(apiKeyEntry('venice'))).toBe(false);
    expect(loadApiKey('venice', storage)).toBe('');
  });

  it('is simply missing when the browser refuses', () => {
    expect(loadApiKey('venice', refusing)).toBe('');
    expect(saveApiKey('venice', 'sk-secret', refusing)).toBe(false);
  });
});

describe('missingFor', () => {
  it('says what a parent still has to set before she can chat in a mode', () => {
    expect(missingFor('chat', SET_UP, '')).toBe('key');
    expect(missingFor('chat', { ...SET_UP, models: { ...SET_UP.models, chat: '' } }, 'sk-secret')).toBe('model');
    expect(missingFor('chat', SET_UP, 'sk-secret')).toBeNull();
  });
});

describe('the model for files', () => {
  it('is absent until the parent names one, and is kept once named', () => {
    expect(loadSettings(memory())).not.toHaveProperty('fileModel');
    expect(sanitizeSettings({ ...SET_UP, fileModel: '   ' })).not.toHaveProperty('fileModel');
    expect(sanitizeSettings({ ...SET_UP, fileModel: 42 })).not.toHaveProperty('fileModel');
    const storage = memory();
    saveSettings({ ...SET_UP, fileModel: ' vision-model ' }, storage);
    expect(loadSettings(storage).fileModel).toBe('vision-model');
    expect(sanitizeSettings({ fileModel: 'x'.repeat(MAX_MODEL_CHARS + 50) }).fileModel).toHaveLength(MAX_MODEL_CHARS);
  });
});


describe('uncensored models', () => {
  const MARKED: Settings = { ...SET_UP, models: { ...SET_UP.models, chat: 'wild-model' }, fileModel: 'wild-reader', uncensored: ['wild-model', 'wild-reader'] };

  it('knows one by the mark saved with it, or by a name that says so', () => {
    expect(isUncensored('wild-model', MARKED)).toBe(true);
    expect(isUncensored('model-b', MARKED)).toBe(false);
    expect(isUncensored('venice-uncensored', SET_UP)).toBe(true);
    expect(isUncensored('some-abliterated-model', SET_UP)).toBe(true);
    expect(isUncensored('', MARKED)).toBe(false);
  });

  it('never gives one to a call while the app is used by a child: its mode counts as not set up', () => {
    expect(modelFor('chat', MARKED)).toBe('');
    expect(missingFor('chat', MARKED, 'sk-secret')).toBe('model');
    expect(fileModelFor(MARKED)).toBe('');
    // The other modes are untouched.
    expect(modelFor('search', MARKED)).toBe('model-b');
    expect(missingFor('search', MARKED, 'sk-secret')).toBeNull();

    const named: Settings = { ...SET_UP, models: { ...SET_UP.models, draw: 'paint-uncensored' }, fileModel: 'reader-abliterated' };
    expect(modelFor('draw', named)).toBe('');
    expect(missingFor('draw', named, 'sk-secret')).toBe('model');
    expect(fileModelFor(named)).toBe('');
  });

  it("gives it in a parent's own use only", () => {
    const parent: Settings = { ...MARKED, parentUse: true };
    expect(modelFor('chat', parent)).toBe('wild-model');
    expect(missingFor('chat', parent, 'sk-secret')).toBeNull();
    expect(fileModelFor(parent)).toBe('wild-reader');
  });

  it('gives an ordinary model either way, and no model for files when none is named', () => {
    expect(modelFor('chat', SET_UP)).toBe('model-a');
    expect(modelFor('chat', { ...SET_UP, parentUse: true })).toBe('model-a');
    expect(fileModelFor(SET_UP)).toBe('');
    expect(fileModelFor({ ...SET_UP, fileModel: 'reader' })).toBe('reader');
  });

  it('keeps the marks through saving, only for models that are chosen, each once', () => {
    const storage = memory();
    saveSettings({ ...MARKED, uncensored: ['wild-model', ' wild-model ', 'not-chosen', 'wild-reader'] }, storage);
    expect(loadSettings(storage).uncensored).toEqual(['wild-model', 'wild-reader']);
    expect(sanitizeSettings({ ...SET_UP, uncensored: ['not-chosen'] })).not.toHaveProperty('uncensored');
    expect(sanitizeSettings({ ...SET_UP, uncensored: 'model-a' })).not.toHaveProperty('uncensored');
    expect(sanitizeSettings({ ...SET_UP, uncensored: [7, null, {}] })).not.toHaveProperty('uncensored');
    expect(sanitizeSettings(SET_UP)).not.toHaveProperty('uncensored');
  });
});
