import { AI_PROVIDERS, type AiProviderId } from '../ai/catalog';
import { MODES, type ModeId } from '../core/modes';

/**
 * What the parent sets, kept in this browser's localStorage: on the phone only.
 * The API key has its own entry, apart from the settings and from the chats, so
 * that a backup or an export of either never carries it.
 *
 * Anything stored on the phone can be read by someone who holds the unlocked phone;
 * that is why the parent should set a spending limit on the provider's side.
 */
export interface Settings {
  provider: AiProviderId;
  /** The provider's model name behind each mode; empty = that mode is not set up yet. */
  models: Record<ModeId, string>;
  /** The parent's own instructions, sent after the built-in ones. */
  systemPrompt: string;
  /** For the greeting only; never sent to the provider. */
  childName: string;
  /** The most messages she can send in a day; null = no limit. */
  dailyLimit: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'venice',
  models: { chat: '', search: '', math: '', draw: '' },
  systemPrompt: '',
  childName: '',
  dailyLimit: null,
};

export const SETTINGS_KEY = 'kid-llm.settings.v1';
export const apiKeyEntry = (provider: AiProviderId) => `kid-llm.key.${provider}`;

export const MAX_SYSTEM_PROMPT_CHARS = 4_000;
export const MAX_NAME_CHARS = 30;
export const MAX_MODEL_CHARS = 200;
export const MAX_DAILY_LIMIT = 1_000;

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');

/**
 * Makes settings out of whatever was stored (or imported): unknown fields are dropped,
 * wrong types fall back to the defaults, long texts are cut. Never throws.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawModels = (value.models && typeof value.models === 'object' ? value.models : {}) as Record<string, unknown>;
  const models = { ...DEFAULT_SETTINGS.models };
  for (const mode of MODES) models[mode.id] = text(rawModels[mode.id], MAX_MODEL_CHARS).trim();
  const limit = value.dailyLimit;
  return {
    provider: typeof value.provider === 'string' && value.provider in AI_PROVIDERS ? (value.provider as AiProviderId) : DEFAULT_SETTINGS.provider,
    models,
    systemPrompt: text(value.systemPrompt, MAX_SYSTEM_PROMPT_CHARS),
    childName: text(value.childName, MAX_NAME_CHARS).trim(),
    dailyLimit: typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 ? Math.min(limit, MAX_DAILY_LIMIT) : null,
  };
}

/** The saved settings, or the defaults when there are none or they can't be read. */
export function loadSettings(storage: KeyValue = localStorage): Settings {
  try {
    const saved = storage.getItem(SETTINGS_KEY);
    return saved ? sanitizeSettings(JSON.parse(saved)) : { ...DEFAULT_SETTINGS, models: { ...DEFAULT_SETTINGS.models } };
  } catch {
    return { ...DEFAULT_SETTINGS, models: { ...DEFAULT_SETTINGS.models } };
  }
}

/** Saves the settings. Returns false when the browser refused (storage off or full). */
export function saveSettings(settings: Settings, storage: KeyValue = localStorage): boolean {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

/** The parent's key for a provider; empty when none is saved. */
export function loadApiKey(provider: AiProviderId, storage: KeyValue = localStorage): string {
  try {
    return storage.getItem(apiKeyEntry(provider))?.trim() ?? '';
  } catch {
    return '';
  }
}

/** Saves the key, or removes it when it is empty. Returns false when the browser refused. */
export function saveApiKey(provider: AiProviderId, apiKey: string, storage: KeyValue = localStorage): boolean {
  try {
    const key = apiKey.trim();
    if (key) storage.setItem(apiKeyEntry(provider), key);
    else storage.removeItem(apiKeyEntry(provider));
    return true;
  } catch {
    return false;
  }
}

/** Why she can't chat in a mode yet, for the "ask a parent" screen; null when it is ready. */
export function missingFor(mode: ModeId, settings: Settings, apiKey: string): 'key' | 'model' | null {
  if (!apiKey) return 'key';
  if (!settings.models[mode]) return 'model';
  return null;
}
