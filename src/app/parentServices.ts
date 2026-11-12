import type { AiProviderId } from '../ai/catalog';
import type { PinResult } from '../storage/pin';
import type { Settings } from '../storage/settings';

/**
 * Everything the parent area needs from the phone and the provider, so tests can stand in
 * for both. There is no way to read the saved key back: the area only learns whether one exists.
 */
export interface ParentServices {
  loadSettings: () => Settings;
  /** False when the phone refused to save. */
  saveSettings: (settings: Settings) => boolean;
  hasApiKey: (provider: AiProviderId) => boolean;
  /** Saves the key; an empty key removes the saved one. False when the phone refused. */
  saveApiKey: (provider: AiProviderId, apiKey: string) => boolean;
  /** Checks the typed key, or the saved one when nothing was typed. Rejects with an AiError. */
  checkConnection: (provider: AiProviderId, typedKey: string) => Promise<string | null>;
  /** A key or settings other than the defaults are saved on the phone. */
  hasSetup: () => boolean;
  /** Removes the saved key and puts the settings back to the defaults. False when the phone refused. */
  forgetSetup: () => boolean;
  hasPin: () => boolean;
  setPin: (pin: string) => Promise<boolean>;
  checkPin: (pin: string) => Promise<PinResult>;
  /** How many milliseconds the area stays locked after too many wrong codes; 0 when it isn't. */
  lockedFor: () => number;
  sentToday: () => number;
  resetUsage: () => boolean;
  /** Removes every chat from the phone. Rejects when it could not. */
  deleteAllChats: () => Promise<void>;
}
