import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { checkConnection, generateImage, listModels, sendChat } from './ai/send';
import { App } from './app/App';
import type { ParentServices } from './app/parentServices';
import type { Services } from './app/useChat';
import { openChatStore, requestPersistence, type ChatStore } from './storage/chatStore';
import { checkPin, hasPin, lockedFor, setPin } from './storage/pin';
import { forgetSetup, hasSetup, loadApiKey, loadSettings, saveApiKey, saveSettings } from './storage/settings';
import { countMessage, resetUsage, sentToday } from './storage/usage';
import './styles.css';

/** The real phone and the real provider behind the app (tests give their own). */
function browserServices(store: ChatStore | null): Services {
  return {
    store,
    loadSettings: () => loadSettings(),
    loadApiKey: (provider) => loadApiKey(provider),
    sendChat,
    generateImage,
    sentToday: () => sentToday(Date.now()),
    countMessage: () => countMessage(Date.now()),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    copyText: (text) => navigator.clipboard.writeText(text),
  };
}

/** The parent area's side of the phone. The saved key goes from storage straight to the provider call; the screen never holds it. */
function browserParentServices(store: ChatStore | null): ParentServices {
  return {
    loadSettings: () => loadSettings(),
    saveSettings: (settings) => saveSettings(settings),
    hasApiKey: (provider) => loadApiKey(provider) !== '',
    saveApiKey: (provider, apiKey) => saveApiKey(provider, apiKey),
    checkConnection: (provider, typedKey) => checkConnection(provider, typedKey.trim() || loadApiKey(provider)),
    listModels: (provider, kind, typedKey) => listModels(provider, kind, typedKey.trim() || loadApiKey(provider)),
    hasSetup: () => hasSetup(),
    forgetSetup: () => forgetSetup(),
    hasPin: () => hasPin(),
    setPin: (pin) => setPin(pin),
    checkPin: (pin) => checkPin(pin, Date.now()),
    lockedFor: () => lockedFor(Date.now()),
    sentToday: () => sentToday(Date.now()),
    resetUsage: () => resetUsage(Date.now()),
    deleteAllChats: async () => {
      await store?.clear();
    },
  };
}

async function start() {
  // Without usable storage she can still chat; the app says that the chat wasn't saved.
  const store = await openChatStore().catch(() => null);
  void requestPersistence();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App services={browserServices(store)} parent={browserParentServices(store)} />
    </StrictMode>,
  );
}

void start();
