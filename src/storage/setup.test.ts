// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { apiKeyEntry, DEFAULT_SETTINGS, forgetSetup, hasSetup, loadApiKey, loadSettings, saveApiKey, saveSettings, SETTINGS_KEY } from './settings';

function memory() {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
  };
}

describe('whether the phone was set up', () => {
  it('is not, on a new phone or with the default settings saved', () => {
    const storage = memory();
    expect(hasSetup(storage)).toBe(false);
    saveSettings(DEFAULT_SETTINGS, storage);
    expect(hasSetup(storage)).toBe(false);
  });

  it('is, once there is a key or any setting of the parent', () => {
    const withKey = memory();
    saveApiKey('venice', 'sk-test', withKey);
    expect(hasSetup(withKey)).toBe(true);

    const withSettings = memory();
    saveSettings({ ...DEFAULT_SETTINGS, childName: 'נועה' }, withSettings);
    expect(hasSetup(withSettings)).toBe(true);
  });

  it('forgets the key and the settings together', () => {
    const storage = memory();
    saveApiKey('venice', 'sk-test', storage);
    saveSettings({ ...DEFAULT_SETTINGS, systemPrompt: 'Be kind.', dailyLimit: 5 }, storage);
    expect(forgetSetup(storage)).toBe(true);
    expect(loadApiKey('venice', storage)).toBe('');
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
    expect(storage.entries.has(apiKeyEntry('venice'))).toBe(false);
    expect(storage.entries.has(SETTINGS_KEY)).toBe(false);
    expect(hasSetup(storage)).toBe(false);
  });

  it('says so when the phone refuses', () => {
    const storage = {
      ...memory(),
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(forgetSetup(storage)).toBe(false);
  });
});
