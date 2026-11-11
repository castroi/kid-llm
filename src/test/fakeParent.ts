import type { ModelInfo, ModelKind } from '../ai/providers';
import type { ParentServices } from '../app/parentServices';
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
  /** The phone refuses to save. */
  refuses: boolean;
  /** What the provider's model list holds, and every key the list was asked for with. */
  models: Record<ModelKind, ModelInfo[]>;
  listedWith: string[];
  /** The provider refuses to list its models. */
  listFails: Error | null;
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
    refuses: false,
    models: { text: [], image: [] },
    listedWith: [],
    listFails: null,
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
    listModels: async (_provider, kind, typedKey) => {
      phone.listedWith.push(typedKey);
      if (phone.listFails) throw phone.listFails;
      return phone.models[kind];
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
  };
  return { parent, phone };
}
