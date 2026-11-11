import { describe, expect, it } from 'vitest';
import {
  apiKeyEntry,
  DEFAULT_SETTINGS,
  loadApiKey,
  loadSettings,
  MAX_DAILY_LIMIT,
  MAX_SYSTEM_PROMPT_CHARS,
  missingFor,
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
