import { useCallback, useRef, useState } from 'react';
import type { AiProviderId } from '../ai/catalog';
import { AiError, type AiErrorReason, type ChatResult } from '../ai/providers';
import type { ChatRequest } from '../ai/send';
import { MAX_MESSAGE_CHARS, newChat, toProviderMessages, withMessage, withUpdatedMessage, type Chat, type StoredMessage } from '../core/chat';
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
  /** How many messages she has sent today, and counting one more (src/storage/usage.ts). */
  sentToday: () => number;
  countMessage: () => void;
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
  /** The last save to the phone failed. */
  notSaved: boolean;
  setMode: (mode: ModeId) => void;
  /** Sends her message. False when nothing was sent (empty, not set up, over the limit, or an answer is being written). */
  send: (text: string) => boolean;
  /** Her "עצירה": ends the answer; what was written stays. */
  stop: () => void;
  /** Asks again for an answer to her last message, replacing the last answer. */
  retry: () => void;
  startNewChat: () => void;
}

export function useChat(services: Services): ChatController {
  const [chat, setChat] = useState<Chat>(() => newChat(DEFAULT_MODE, services.now(), services.newId()));
  const [mode, setModeState] = useState<ModeId>(DEFAULT_MODE);
  const [writing, setWriting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [notSaved, setNotSaved] = useState(false);

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
   * the end of an answer, written only if the chat is still there, so a chat deleted
   * meanwhile doesn't come back.
   */
  const keep = useCallback(
    (toSave: Chat, created: boolean) => {
      if (!services.store) return;
      const saving: Promise<unknown> = created ? services.store.save(toSave) : services.store.update(toSave);
      saving.then(
        () => setNotSaved(false),
        () => setNotSaved(true),
      );
    },
    [services.store],
  );

  /** Asks the provider for the answer to `base` (which ends with her message) and writes it as it arrives. */
  const answer = useCallback(
    async (base: Chat, forMode: ModeId, settings: Settings, apiKey: string) => {
      const reply: StoredMessage = { id: services.newId(), role: 'assistant', text: '', at: services.now(), mode: forMode };
      let current = withMessage(base, reply);
      let text = '';
      // If she moved to another chat meanwhile, this one keeps being written in the background only.
      const put = (next: Chat) => {
        current = next;
        if (shown.current.id === next.id) show(next);
      };
      const write = (state?: StoredMessage['state']) => put(withUpdatedMessage(current, state ? { ...reply, text, state } : { ...reply, text }));
      const drop = () => put({ ...current, messages: current.messages.filter((m) => m.id !== reply.id) });

      const controller = new AbortController();
      stopper.current = controller;
      busy.current = true;
      setWriting(true);
      setNotice(null);
      put(current);
      try {
        await services.sendChat({
          provider: settings.provider,
          model: settings.models[forMode],
          systemPrompt: settings.systemPrompt,
          messages: toProviderMessages(base.messages),
          apiKey,
          signal: controller.signal,
          onDelta: (piece) => {
            text += piece;
            write();
          },
        });
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
    [services, show, keep],
  );

  const send = useCallback(
    (text: string): boolean => {
      const mine = text.trim();
      if (!mine || busy.current || !isReady(mode)) return false;
      const settings = services.loadSettings();
      const apiKey = services.loadApiKey(settings.provider);
      if (missingFor(mode, settings, apiKey)) return false;

      if (settings.dailyLimit !== null && services.sentToday() >= settings.dailyLimit) {
        setNotice({ kind: 'limit' });
        return false;
      }
      const base = withMessage(shown.current, { id: services.newId(), role: 'user', text: cut(mine, MAX_MESSAGE_CHARS), at: services.now(), mode });
      services.countMessage();
      show(base);
      keep(base, true);
      void answer(base, mode, settings, apiKey);
      return true;
    },
    [services, mode, show, keep, answer],
  );

  const stop = useCallback(() => stopper.current?.abort(), []);

  const retry = useCallback(() => {
    if (busy.current || !isReady(mode)) return;
    const messages = shown.current.messages;
    let last = messages.length - 1;
    while (last >= 0 && messages[last].role !== 'user') last--;
    if (last < 0) return;
    const settings = services.loadSettings();
    const apiKey = services.loadApiKey(settings.provider);
    if (missingFor(mode, settings, apiKey)) return;
    // The answers after her last message are replaced by the new one.
    const base = { ...shown.current, messages: messages.slice(0, last + 1) };
    if (toProviderMessages(base.messages).length === 0) return;
    void answer(base, mode, settings, apiKey);
  }, [services, mode, answer]);

  const startNewChat = useCallback(() => {
    stopper.current?.abort();
    stopper.current = null;
    busy.current = false;
    setWriting(false);
    setNotice(null);
    show(newChat(mode, services.now(), services.newId()));
  }, [services, mode, show]);

  const setMode = useCallback((next: ModeId) => {
    if (isReady(next)) setModeState(next);
  }, []);

  return { chat, mode, writing, notice, notSaved, setMode, send, stop, retry, startNewChat };
}
