import { AI_PROVIDERS, type AiProviderId } from '../ai/catalog';
import { looksUncensored } from '../ai/models';
import { MODES, type ModeId } from '../core/modes';
import { cut } from '../core/text';

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
  /**
   * The model her attached pictures and documents are sent to; it has to be one that can
   * read pictures. Absent = not set up: she gets no attach button and no file leaves the phone.
   */
  fileModel?: string;
  /** The parent's own instructions, sent after the built-in ones. May describe her; a backup that includes it says so. */
  systemPrompt: string;
  /** Her name, for the greeting only; never sent to the provider. Personal: a backup that includes it says so. */
  childName: string;
  /** The most messages she can send in a day; null = no limit. */
  dailyLimit: number | null;
  /**
   * A parent uses the app themself: the built-in child instructions are not sent with a chat.
   * Absent = the app is used by a child, which is the default and what anything unreadable means.
   */
  parentUse?: true;
  /**
   * Which of the chosen models the provider's list marks as uncensored. Such a model answers
   * only in a parent's own use: for a child its mode counts as not set up (`modelFor`).
   * Absent = none. Written by the parent area from the provider's list.
   */
  uncensored?: string[];
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

const text = (value: unknown, max: number): string => (typeof value === 'string' ? cut(value, max) : '');

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
  const fileModel = text(value.fileModel, MAX_MODEL_CHARS).trim();
  // Only marks for models that are chosen are kept, each once.
  const chosen = new Set([...Object.values(models), fileModel].filter((model) => model !== ''));
  const marked = Array.isArray(value.uncensored) ? value.uncensored.map((model) => text(model, MAX_MODEL_CHARS).trim()) : [];
  const uncensored = [...chosen].filter((model) => marked.includes(model));
  return {
    provider: typeof value.provider === 'string' && Object.hasOwn(AI_PROVIDERS, value.provider) ? (value.provider as AiProviderId) : DEFAULT_SETTINGS.provider,
    models,
    ...(fileModel ? { fileModel } : {}),
    systemPrompt: text(value.systemPrompt, MAX_SYSTEM_PROMPT_CHARS),
    childName: text(value.childName, MAX_NAME_CHARS).trim(),
    dailyLimit: typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 ? Math.min(limit, MAX_DAILY_LIMIT) : null,
    // Only the exact value a parent's untick saves; anything else is a child's phone.
    ...(value.parentUse === true ? { parentUse: true as const } : {}),
    ...(uncensored.length > 0 ? { uncensored } : {}),
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

/**
 * An uncensored model: the provider's list marked it so when the parent chose it, or its
 * name says so (a name typed by hand has no mark).
 */
export function isUncensored(model: string, settings: Settings): boolean {
  return model !== '' && (looksUncensored(model) || (settings.uncensored ?? []).includes(model));
}

/** A model as it may be called now: an uncensored one only in a parent's own use, otherwise none. */
function allowed(model: string, settings: Settings): string {
  return settings.parentUse !== true && isUncensored(model, settings) ? '' : model;
}

/**
 * The model to call for a mode; empty when none is set, and also when the one that is set is
 * uncensored and the app is used by a child. Every call takes its model from here or from
 * `fileModelFor`, so an uncensored model can't answer her.
 */
export function modelFor(mode: ModeId, settings: Settings): string {
  return allowed(settings.models[mode], settings);
}

/** The model her attached files go to, under the same rule as `modelFor`; empty = no attaching. */
export function fileModelFor(settings: Settings): string {
  return allowed(settings.fileModel ?? '', settings);
}

/** Why she can't chat in a mode yet, for the "ask a parent" screen; null when it is ready. */
export function missingFor(mode: ModeId, settings: Settings, apiKey: string): 'key' | 'model' | null {
  if (!apiKey) return 'key';
  if (!modelFor(mode, settings)) return 'model';
  return null;
}

/** A key, or settings other than the defaults, are saved on this phone. */
export function hasSetup(storage: KeyValue = localStorage): boolean {
  const fresh = JSON.stringify(sanitizeSettings(DEFAULT_SETTINGS));
  return Object.keys(AI_PROVIDERS).some((provider) => loadApiKey(provider as AiProviderId, storage) !== '') || JSON.stringify(loadSettings(storage)) !== fresh;
}

/** Removes every saved key and the settings. Returns false when the browser refused. */
export function forgetSetup(storage: KeyValue = localStorage): boolean {
  try {
    for (const provider of Object.keys(AI_PROVIDERS)) storage.removeItem(apiKeyEntry(provider as AiProviderId));
    storage.removeItem(SETTINGS_KEY);
    return true;
  } catch {
    return false;
  }
}
