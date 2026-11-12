import { useCallback, useRef, useState } from 'react';
import type { AiProviderId } from '../ai/catalog';
import { AiError, type AiErrorReason, type ChatResult, type GeneratedImage } from '../ai/providers';
import type { ChatRequest, ImageRequest } from '../ai/send';
import type { Source } from '../ai/sources';
import { forgetParsed } from '../core/answerText';
import { MAX_MESSAGE_CHARS, newChat, titleFrom, toProviderMessages, withMessage, withUpdatedMessage, type Chat, type ChatSummary, type StoredMessage } from '../core/chat';
import { cut } from '../core/text';
import { DEFAULT_MODE, isReady, type ModeId } from '../core/modes';
import type { ChatStore } from '../storage/chatStore';
import { missingFor, type Settings } from '../storage/settings';

/** Everything the chat needs from outside, so tests can stand in for the phone and the provider. */
export interface Services {
  /** null when the browser has no usable storage: she can still chat, but nothing is kept. */
  store: ChatStore | null;
  loadSettings: () => Settings;
  loadApiKey: (provider: AiProviderId) => string;
  sendChat: (request: ChatRequest) => Promise<ChatResult>;
  /** Makes one picture of what she wrote (drawing mode). */
  generateImage: (request: ImageRequest) => Promise<GeneratedImage>;
  /** How many messages she has sent today, and counting one more (src/storage/usage.ts). */
  sentToday: () => number;
  /** False when the phone refused to write the count. */
  countMessage: () => boolean;
  now: () => number;
  newId: () => string;
  copyText: (text: string) => Promise<void>;
}

export type Notice = { kind: 'error'; reason: AiErrorReason } | { kind: 'limit' } | null;

export interface ChatController {
  chat: Chat;
  mode: ModeId;
  /** An answer is being written right now. */
  writing: boolean;
  notice: Notice;
  /** The chat on the screen is not on the phone: the last save failed, or the browser has no storage. */
  notSaved: boolean;
  setMode: (mode: ModeId) => void;
  /** Sends her message. False when nothing was sent (empty, not set up, over the limit, or an answer is being written). */
  send: (text: string) => boolean;
  /** Her "עצירה": ends the answer; what was written stays. */
  stop: () => void;
  /** Asks again for an answer to her last message, replacing the last answer. */
  retry: () => void;
  startNewChat: () => void;
  /** Her saved chats, most recently used first; empty when nothing is kept on this phone. */
  listChats: () => Promise<ChatSummary[]>;
  /** Puts a saved chat on the screen. False when it is no longer on the phone. */
  openChat: (id: string) => Promise<boolean>;
  /** Gives a saved chat another name. False when it wasn't saved (also while its answer is being written). */
  renameChat: (id: string, title: string) => Promise<boolean>;
}

export function useChat(services: Services): ChatController {
  const [chat, setChat] = useState<Chat>(() => newChat(DEFAULT_MODE, services.now(), services.newId()));
  const [mode, setModeState] = useState<ModeId>(DEFAULT_MODE);
  const [writing, setWriting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // The chat whose last save failed. The notice belongs to that chat only.
  const [unsavedId, setUnsavedId] = useState<string | null>(null);
  // Messages the phone refused to count; the limit still holds until the app is closed.
  const uncounted = useRef(0);

  // What the screen shows now, for the steps that run while an answer is being written.
  const shown = useRef(chat);
  const stopper = useRef<AbortController | null>(null);
  const busy = useRef(false);

  const show = useCallback((next: Chat) => {
    shown.current = next;
    setChat(next);
  }, []);

  /**
   * Saves to the phone. `created` is her new message (the chat may be new); otherwise it is
   * the end of an answer, written only if the chat is still there, so a chat the parent
   * deleted meanwhile ("delete all") doesn't come back.
   */
  const keep = useCallback(
    (toSave: Chat, created: boolean) => {
      if (!services.store) return;
      const saving: Promise<boolean> = created ? services.store.save(toSave).then(() => true) : services.store.update(toSave);
      saving.then(
        // "Saved" only after a write that really happened; update() writes nothing when the chat is gone.
        (written) => {
          if (written) setUnsavedId((id) => (id === toSave.id ? null : id));
        },
        () => setUnsavedId(toSave.id),
      );
    },
    [services.store],
  );

  const count = useCallback(() => {
    if (!services.countMessage()) uncounted.current += 1;
  }, [services]);

  /** Asks the provider for the answer to `base` (which ends with her message) and writes it as it arrives. */
  const answer = useCallback(
    async (base: Chat, forMode: ModeId, settings: Settings, apiKey: string, replaced: readonly StoredMessage[] = [], countOnFirstPiece = false) => {
      const reply: StoredMessage = { id: services.newId(), role: 'assistant', text: '', at: services.now(), mode: forMode };
      let current = withMessage(base, reply);
      let text = '';
      let image: GeneratedImage | undefined;
      let sources: Source[] | undefined;
      // If she moved to another chat meanwhile, this one keeps being written in the background only.
      const put = (next: Chat) => {
        current = next;
        if (shown.current.id === next.id) show(next);
      };
      const write = (state?: StoredMessage['state']) => put(withUpdatedMessage(current, { ...reply, text, ...(image ? { image } : {}), ...(sources ? { sources } : {}), ...(state ? { state } : {}) }));
      // Nothing new was written: the empty answer goes, and an answer this call was meant to replace comes back.
      const drop = () => put({ ...current, messages: [...base.messages, ...replaced] });

      const controller = new AbortController();
      stopper.current = controller;
      busy.current = true;
      setWriting(true);
      setNotice(null);
      put(current);
      try {
        if (forMode === 'draw') {
          // A picture is made from her last message alone; nothing else of the chat is sent.
          image = await services.generateImage({
            provider: settings.provider,
            model: settings.models.draw,
            prompt: base.messages[base.messages.length - 1].text,
            apiKey,
            signal: controller.signal,
          });
          // Another picture for the same request counts toward the day once it really arrives.
          if (countOnFirstPiece) count();
        } else {
          const result = await services.sendChat({
            provider: settings.provider,
            model: settings.models[forMode],
            systemPrompt: settings.systemPrompt,
            // A search call carries only what she wrote in search mode (and its answers): what she
            // said in other modes of the same chat is not handed to a search engine.
            messages: toProviderMessages(forMode === 'search' ? base.messages.filter((m) => m.mode === 'search') : base.messages),
            apiKey,
            webSearch: forMode === 'search',
            signal: controller.signal,
            onDelta: (piece) => {
              // Another answer to the same message counts toward the day only once it really arrives.
              if (countOnFirstPiece && text === '') count();
              text += piece;
              write();
            },
          });
          // The sites a search answer came from are kept with it once it ended well; an answer
          // she stopped or that failed has none.
          if (forMode === 'search' && result.sources && result.sources.length > 0) sources = result.sources;
        }
        write();
      } catch (err) {
        // Anything unexpected is shown like a broken answer; the provider's own text never reaches her.
        const reason: AiErrorReason = err instanceof AiError ? err.reason : 'bad-response';
        if (reason === 'cancelled') {
          if (text) write('stopped');
          else drop();
        } else {
          if (text) write('failed');
          else drop();
          if (shown.current.id === current.id) setNotice({ kind: 'error', reason });
        }
      } finally {
        if (stopper.current === controller) {
          stopper.current = null;
          busy.current = false;
          setWriting(false);
        }
        keep(current, false);
      }
    },
    [services, show, keep, count],
  );

  /** True (with the kind notice) when she has used up the day. */
  const overLimit = useCallback(
    (settings: Settings): boolean => {
      if (settings.dailyLimit === null || services.sentToday() + uncounted.current < settings.dailyLimit) return false;
      setNotice({ kind: 'limit' });
      return true;
    },
    [services],
  );

  const send = useCallback(
    (text: string): boolean => {
      const mine = text.trim();
      if (!mine || busy.current || !isReady(mode)) return false;
      const settings = services.loadSettings();
      const apiKey = services.loadApiKey(settings.provider);
      if (missingFor(mode, settings, apiKey)) return false;

      if (overLimit(settings)) return false;
      const base = withMessage(shown.current, { id: services.newId(), role: 'user', text: cut(mine, MAX_MESSAGE_CHARS), at: services.now(), mode });
      count();
      show(base);
      keep(base, true);
      void answer(base, mode, settings, apiKey);
      return true;
    },
    [services, mode, show, keep, answer, overLimit, count],
  );

  const stop = useCallback(() => stopper.current?.abort(), []);

  const retry = useCallback(() => {
    if (busy.current) return;
    const messages = shown.current.messages;
    let last = messages.length - 1;
    while (last >= 0 && messages[last].role !== 'user') last--;
    if (last < 0) return;
    // Asked again in the mode her message was written in, whatever the picker shows now:
    // a question from plain chat is never sent to a web search by "try again".
    const forMode = messages[last].mode;
    if (!isReady(forMode)) return;
    const settings = services.loadSettings();
    const apiKey = services.loadApiKey(settings.provider);
    if (missingFor(forMode, settings, apiKey)) return;
    // The answers after her last message are replaced by the new one, once it starts to arrive.
    const base = { ...shown.current, messages: messages.slice(0, last + 1) };
    const replaced = messages.slice(last + 1);
    if (forMode !== 'draw' && toProviderMessages(base.messages).length === 0) return;
    // Trying again after a failure is free. Asking for another answer when one arrived is
    // a paid call like any message: it stops at the limit, and counts once the new answer arrives.
    const hadAnswer = replaced.some((m) => (m.text.trim() !== '' || m.image !== undefined) && m.state !== 'failed');
    if (hadAnswer && overLimit(settings)) return;
    void answer(base, forMode, settings, apiKey, replaced, hadAnswer);
  }, [services, answer, overLimit]);

  /** Leaves the chat on the screen: an answer being written is stopped (what was written is kept with its chat). */
  const leave = useCallback(() => {
    stopper.current?.abort();
    stopper.current = null;
    busy.current = false;
    setWriting(false);
    setNotice(null);
    forgetParsed();
  }, []);

  const startNewChat = useCallback(() => {
    leave();
    show(newChat(mode, services.now(), services.newId()));
  }, [services, mode, show, leave]);

  const listChats = useCallback(async (): Promise<ChatSummary[]> => (services.store ? services.store.list() : []), [services.store]);

  const openChat = useCallback(
    async (id: string): Promise<boolean> => {
      if (id === shown.current.id) return true;
      const found = await services.store?.get(id).catch(() => undefined);
      if (!found) return false;
      leave();
      show(found);
      if (isReady(found.mode)) setModeState(found.mode);
      return true;
    },
    [services.store, show, leave],
  );

  const renameChat = useCallback(
    async (id: string, title: string): Promise<boolean> => {
      // While its answer is being written the chat is about to be saved again; the name waits.
      if (!services.store || !title.trim() || (busy.current && shown.current.id === id)) return false;
      try {
        const name = titleFrom(title);
        const written = await services.store.rename(id, name);
        if (written && shown.current.id === id) show({ ...shown.current, title: name });
        return written;
      } catch {
        return false;
      }
    },
    [services.store, show],
  );

  const setMode = useCallback((next: ModeId) => {
    if (isReady(next)) setModeState(next);
  }, []);

  const notSaved = services.store === null || unsavedId === chat.id;
  return { chat, mode, writing, notice, notSaved, setMode, send, stop, retry, startNewChat, listChats, openChat, renameChat };
}
