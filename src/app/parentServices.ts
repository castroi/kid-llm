import type { AiProviderId } from '../ai/catalog';
import type { ModelInfo } from '../ai/models';
import type { BackupSource, ImportResult } from '../core/backup';
import type { AppVersion } from '../core/version';
import type { Backup, HandOver } from '../storage/backup';
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
  /** The provider's models, asked for with the typed key, or the saved one when nothing was typed. Rejects with an AiError. */
  listModels: (provider: AiProviderId, typedKey: string) => Promise<ModelInfo[]>;
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
  /** Every chat on the phone as one backup file. Never the key, the code or the settings. Rejects when the chats can't be read. */
  makeBackup: () => Promise<Backup>;
  /** Hands a made backup to the parent: the share sheet where it takes files, a download elsewhere. Called straight from a tap. */
  saveBackup: (backup: Backup) => Promise<HandOver>;
  /** Adds a backup file's chats to the phone; chats already here are left as they are. Rejects with BackupError for a file that is no backup. */
  importBackup: (file: BackupSource) => Promise<ImportResult>;
  /** Which build of the app is on this phone. */
  version: AppVersion;
}
