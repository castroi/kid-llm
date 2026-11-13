import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { checkConnection, generateImage, listModels, sendChat } from './ai/send';
import { App } from './app/App';
import type { ParentServices } from './app/parentServices';
import type { Services } from './app/useChat';
import { prepareAttachment, type PickedFile } from './core/attachment';
import { APP_VERSION } from './core/version';
import { openChatStore, requestPersistence, type ChatStore } from './storage/chatStore';
import { checkPin, hasPin, lockedFor, setPin } from './storage/pin';
import { forgetSetup, hasSetup, loadApiKey, loadSettings, saveApiKey, saveSettings } from './storage/settings';
import { countMessage, resetUsage, sentToday } from './storage/usage';
import './styles.css';

/** The longest side of a picture she attaches, in pixels: enough to read a homework sheet, small enough to send. */
const MAX_PICTURE_SIDE = 1568;
/** Smaller than this the provider refuses a picture. */
const MIN_PICTURE_SIDE = 64;

/** More dots than any phone's camera makes; a picture that claims more is not drawn (it could use up the phone's memory). */
const MAX_PICTURE_PIXELS = 50_000_000;
/** Opening and redrawing a photo takes a moment; after this long it is given up on. */
const REDRAW_TIMEOUT_MS = 20_000;

async function redraw(address: string): Promise<ArrayBuffer> {
  const picture = new Image();
  const opened = new Promise<void>((resolve, reject) => {
    picture.onload = () => resolve();
    picture.onerror = () => reject(new Error('cannot open the picture'));
  });
  picture.src = address;
  await opened;
  // Its size is known before any of it is drawn.
  const { naturalWidth, naturalHeight } = picture;
  if (Math.min(naturalWidth, naturalHeight) < MIN_PICTURE_SIDE) throw new Error('picture too small');
  if (naturalWidth * naturalHeight > MAX_PICTURE_PIXELS) throw new Error('picture too large');
  const scale = Math.min(1, MAX_PICTURE_SIDE / Math.max(naturalWidth, naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(naturalWidth * scale);
  canvas.height = Math.round(naturalHeight * scale);
  const pen = canvas.getContext('2d');
  if (!pen) throw new Error('no canvas');
  // A see-through background would turn black in a JPEG; paper is white.
  pen.fillStyle = 'white';
  pen.fillRect(0, 0, canvas.width, canvas.height);
  pen.drawImage(picture, 0, 0, canvas.width, canvas.height);
  const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!jpeg) throw new Error('no picture');
  return await jpeg.arrayBuffer();
}

/**
 * Redraws a picture she picked as a JPEG no larger than MAX_PICTURE_SIDE. Only what is seen
 * is drawn, so the new picture has none of the photo's hidden data (where and when it was
 * taken, the phone's model). Rejects when the browser can't open the picture, when it is
 * far too large to draw, or when it takes too long.
 */
async function encodeImage(file: PickedFile): Promise<ArrayBuffer> {
  const address = URL.createObjectURL(file as Blob);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tooSlow = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the picture took too long')), REDRAW_TIMEOUT_MS);
  });
  try {
    return await Promise.race([redraw(address), tooSlow]);
  } finally {
    clearTimeout(timer);
    URL.revokeObjectURL(address);
  }
}

/** The real phone and the real provider behind the app (tests give their own). */
function browserServices(store: ChatStore | null): Services {
  return {
    store,
    loadSettings: () => loadSettings(),
    loadApiKey: (provider) => loadApiKey(provider),
    sendChat,
    prepareAttachment: (file) => prepareAttachment(file, encodeImage),
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
    listModels: (provider, typedKey) => listModels(provider, typedKey.trim() || loadApiKey(provider)),
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
    version: APP_VERSION,
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
