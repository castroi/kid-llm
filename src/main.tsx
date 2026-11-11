import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { sendChat } from './ai/send';
import { App } from './app/App';
import type { Services } from './app/useChat';
import { openChatStore, requestPersistence, type ChatStore } from './storage/chatStore';
import { loadApiKey, loadSettings } from './storage/settings';
import { countMessage, sentToday } from './storage/usage';
import './styles.css';

/** The real phone and the real provider behind the app (tests give their own). */
function browserServices(store: ChatStore | null): Services {
  return {
    store,
    loadSettings: () => loadSettings(),
    loadApiKey: (provider) => loadApiKey(provider),
    sendChat,
    sentToday: () => sentToday(Date.now()),
    countMessage: () => countMessage(Date.now()),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    copyText: (text) => navigator.clipboard.writeText(text),
  };
}

async function start() {
  // Without usable storage she can still chat; the app says that the chat wasn't saved.
  const store = await openChatStore().catch(() => null);
  void requestPersistence();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App services={browserServices(store)} />
    </StrictMode>,
  );
}

void start();
