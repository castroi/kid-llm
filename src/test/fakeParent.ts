import type { ModelInfo } from '../ai/models';
import type { ParentServices } from '../app/parentServices';
import type { BackupSource, ImportResult } from '../core/backup';
import type { Backup, HandOver } from '../storage/backup';
import { appVersion, type AppVersion } from '../core/version';
import type { PinResult } from '../storage/pin';
import { DEFAULT_SETTINGS, type Settings } from '../storage/settings';

export interface FakePhone {
  settings: Settings;
  apiKey: string;
  pin: string | null;
  lockedMs: number;
  sent: number;
  chatsDeleted: number;
  /** Every code that was tried, in order. */
  tried: string[];
  /** Every key a connection check was made with ('' = the saved one). */
  checkedWith: string[];
  /** What the provider's list of models holds. */
  models: ModelInfo[];
  /** The list of models can't be loaded: the call rejects with this. */
  listFails: unknown;
  /** Every key the list of models was asked for with ('' = the saved one). */
  listedWith: string[];
  /** How many chats the phone holds for a backup. */
  chats: number;
  /** Every backup that was handed over, in order. */
  handed: Backup[];
  /** How handing a backup over ends. */
  handOver: HandOver;
  /** Every file that was given to import, in order. */
  imported: BackupSource[];
  /** What importing a file gives; an Error is thrown instead. */
  importGives: ImportResult | Error;
  /** The phone refuses to save. */
  refuses: boolean;
  /** The build the parent area says it is. */
  version: AppVersion;
}

/** A phone in memory for the parent area's tests. `check` stands in for the provider's key check. */
export function fakeParent(initial: Partial<FakePhone> = {}, check: () => Promise<string | null> = async () => null): { parent: ParentServices; phone: FakePhone } {
  const phone: FakePhone = {
    settings: { ...DEFAULT_SETTINGS, models: { ...DEFAULT_SETTINGS.models } },
    apiKey: '',
    pin: null,
    lockedMs: 0,
    sent: 0,
    chatsDeleted: 0,
    tried: [],
    checkedWith: [],
    models: [],
    listFails: null,
    listedWith: [],
    chats: 2,
    handed: [],
    handOver: 'shared',
    imported: [],
    importGives: { added: 2, addedParent: 0, kept: 0, unreadable: 0, ended: 'whole' },
    refuses: false,
    version: appVersion('0123456789abcdef0123456789abcdef01234567', '2026-11-12T14:05:00+02:00'),
    ...initial,
  };
  const parent: ParentServices = {
    loadSettings: () => phone.settings,
    saveSettings: (settings) => {
      if (phone.refuses) return false;
      phone.settings = settings;
      return true;
    },
    hasApiKey: () => phone.apiKey !== '',
    saveApiKey: (_provider, apiKey) => {
      if (phone.refuses) return false;
      phone.apiKey = apiKey.trim();
      return true;
    },
    checkConnection: (_provider, typedKey) => {
      phone.checkedWith.push(typedKey);
      return check();
    },
    listModels: async (_provider, typedKey) => {
      phone.listedWith.push(typedKey);
      if (phone.listFails) throw phone.listFails;
      return phone.models;
    },
    hasSetup: () => phone.apiKey !== '' || JSON.stringify(phone.settings) !== JSON.stringify(DEFAULT_SETTINGS),
    forgetSetup: () => {
      if (phone.refuses) return false;
      phone.apiKey = '';
      phone.settings = { ...DEFAULT_SETTINGS, models: { ...DEFAULT_SETTINGS.models } };
      return true;
    },
    hasPin: () => phone.pin !== null,
    setPin: async (pin) => {
      if (phone.refuses) return false;
      phone.pin = pin;
      return true;
    },
    checkPin: async (pin): Promise<PinResult> => {
      phone.tried.push(pin);
      if (phone.lockedMs > 0) return 'locked';
      return pin === phone.pin ? 'ok' : 'wrong';
    },
    lockedFor: () => phone.lockedMs,
    sentToday: () => phone.sent,
    resetUsage: () => {
      if (phone.refuses) return false;
      phone.sent = 0;
      return true;
    },
    deleteAllChats: async () => {
      if (phone.refuses) throw new Error('refused');
      phone.chatsDeleted += 1;
    },
    makeBackup: async () => {
      if (phone.refuses) throw new Error('refused');
      return { file: new File(['x'.repeat(2048)], 'kid-llm-backup-2026-11-16.kidllm'), chats: phone.chats };
    },
    saveBackup: async (backup) => {
      phone.handed.push(backup);
      return phone.handOver;
    },
    importBackup: async (file) => {
      phone.imported.push(file);
      if (phone.importGives instanceof Error) throw phone.importGives;
      return phone.importGives;
    },
    version: phone.version,
  };
  return { parent, phone };
}
