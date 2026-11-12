import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiProviderId } from '../ai/catalog';
import { AiError, type AiErrorReason, type ChatResult, type GeneratedImage } from '../ai/providers';
import type { ChatRequest, ImageRequest } from '../ai/send';
import type { Source } from '../ai/sources';
import { forgetParsed } from '../core/answerText';
import { canAttachIn, type Attachment } from '../core/attachment';
import { MAX_MESSAGE_CHARS, newChat, titleFrom, toProviderMessages, withMessage, withNewestFileRefused, withUpdatedMessage, type Chat, type ChatSummary, type StoredMessage } from '../core/chat';
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
  /** Makes a file she picked ready to attach (src/core/attachment.ts). Rejects with an AttachmentError. */
  prepareAttachment: (file: File) => Promise<Attachment>;
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

/**
 * How many times the app asks again by itself for one message of hers, when the phone cut
 * the answer because the app left the screen. Past this she gets the usual "try again".
 */
export const MAX_RESUMES = 3;

/** An answer the phone cut while the app was off the screen: how the chat was left, and whether the next call still has to be counted. */
interface Cut {
  chat: Chat;
  countOnFirstPiece: boolean;
  /** Why the call ended, for the notice she gets if the app does not ask again after all. */
  reason: AiErrorReason;
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
  /**
   * Sends her message, with the file she attached if there is one. False when nothing was sent
   * (empty, not set up, over the limit, an answer is being written, or a file where none can go).
   */
  send: (text: string, attachment?: Attachment) => boolean;
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
   *
   * `parentUse`: the call was made while a parent used the app themself. Nothing of it is
   * written to the phone, so her list of chats never holds an answer that was written
   * without the child instructions; the screen says that the chat isn't saved.
   */
  const keep = useCallback(
    (toSave: Chat, created: boolean, parentUse: boolean) => {
      if (!services.store) return;
      if (parentUse) return setUnsavedId(toSave.id);
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

  // The app leaving the screen and coming back (home screen, another app, a locked phone).
  // iOS stops a web app's code and its connection soon after it leaves, so an answer being
  // written then is cut; nothing in a web page can keep it going.
  /** How many times the app left the screen or came back. */
  const flips = useRef(0);
  /** Saves what was written so far, for the answer being written now. */
  const onHide = useRef<(() => void) | null>(null);
  /** Calls waiting for the app to be back on the screen. */
  const waiting = useRef<(() => void)[]>([]);
  useEffect(() => {
    const onChange = () => {
      flips.current += 1;
      if (document.visibilityState === 'hidden') onHide.current?.();
      else for (const go of waiting.current.splice(0)) go();
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  /** Resolves once the app is on the screen: at once when it already is. */
  const backOnScreen = useCallback(
    () =>
      new Promise<void>((resolve) => {
        if (document.visibilityState === 'hidden') waiting.current.push(resolve);
        else resolve();
      }),
    [],
  );

  /**
   * One call to the provider for the answer to `base` (which ends with her message), written
   * as it arrives. Resolves with a `Cut` when the phone cut the call because the app left the
   * screen and `mayResume` allows asking again; with null in every other case.
   */
  const attempt = useCallback(
    async (base: Chat, forMode: ModeId, settings: Settings, apiKey: string, replaced: readonly StoredMessage[], countOnFirstPiece: boolean, mayResume: boolean): Promise<Cut | null> => {
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

      // What a chat call carries. A search call carries only what she wrote in search mode (and
      // its answers): what she said in other modes of the same chat is not handed to a search engine.
      const talk = forMode === 'draw' ? [] : toProviderMessages(forMode === 'search' ? base.messages.filter((m) => m.mode === 'search') : base.messages);
      // A call that carries a file goes to the model the parent chose for files. With none
      // chosen (the parent took it away since), the file stays on the phone and only the text goes.
      const fileModel = canAttachIn(forMode) ? (settings.fileModel ?? '') : '';
      const withFile = fileModel !== '' && talk.some((m) => m.file !== undefined);

      const controller = new AbortController();
      stopper.current = controller;
      busy.current = true;
      setWriting(true);
      setNotice(null);
      put(current);
      // `flips` as it was when the last piece arrived on a screen she could see. A call that
      // fails with a different count was cut by leaving: nothing arrived since she came back.
      let flipsSeen = flips.current;
      // The app is leaving the screen: iOS may close it for good, so what was written so far is
      // saved now, marked as cut off. The end of the answer, if it comes, is saved over it.
      const saveWritten = () => {
        // A parent's own chat is never written to the phone (see `keep`), not even half of it.
        if (text === '' || !services.store || settings.parentUse === true) return;
        void services.store.update(withUpdatedMessage(current, { ...reply, text, state: 'failed' })).catch(() => undefined);
      };
      onHide.current = saveWritten;
      let cut: Cut | null = null;
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
            model: withFile ? fileModel : settings.models[forMode],
            systemPrompt: settings.systemPrompt,
            messages: withFile ? talk : talk.map(({ role, content }) => ({ role, content })),
            apiKey,
            webSearch: forMode === 'search',
            // The child baseline is left out only when a parent switched the app to their own use.
            ...(settings.parentUse === true ? { kidUse: false } : {}),
            signal: controller.signal,
            onDelta: (piece) => {
              // Another answer to the same message counts toward the day only once it really arrives.
              if (countOnFirstPiece && text === '') count();
              text += piece;
              write();
              if (document.visibilityState !== 'hidden') flipsSeen = flips.current;
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
          // The provider would not take the request that carried her file (a model that reads no
          // files, or a file it can't open): the file is not sent again, so the chat isn't stuck on it.
          if (reason === 'bad-request' && withFile) put({ ...current, messages: withNewestFileRefused(current.messages) });
          // The phone cut the call while the app was off the screen: she gets no error for
          // switching apps; the app asks again by itself. Never after her stop (that is `cancelled`).
          const cutByLeaving = mayResume && (reason === 'network' || reason === 'timeout') && flips.current !== flipsSeen && shown.current.id === current.id;
          // A call that was to be counted when its answer arrived, and got nothing, is still to be counted.
          if (cutByLeaving) cut = { chat: current, countOnFirstPiece: countOnFirstPiece && text === '', reason };
          else if (shown.current.id === current.id) setNotice({ kind: 'error', reason });
        }
      } finally {
        if (onHide.current === saveWritten) onHide.current = null;
        if (stopper.current === controller) {
          stopper.current = null;
          busy.current = false;
          setWriting(false);
        }
        keep(current, false, settings.parentUse === true);
      }
      return cut;
    },
    [services, show, keep, count],
  );

  /**
   * Asks the provider for the answer to `base` and writes it as it arrives. When the phone
   * cut the answer because the app left the screen, asks again once she is back, up to
   * MAX_RESUMES times: the same messages, free of the daily count, replacing what was cut.
   */
  const answer = useCallback(
    async (base: Chat, forMode: ModeId, settings: Settings, apiKey: string, replaced: readonly StoredMessage[] = [], countOnFirstPiece = false) => {
      for (let resumes = 0; ; resumes++) {
        const cut = await attempt(base, forMode, settings, apiKey, replaced, countOnFirstPiece, resumes < MAX_RESUMES);
        if (!cut) return;
        await backOnScreen();
        // Only if nothing else happened meanwhile: the same chat is on the screen, as the call left it.
        if (busy.current || shown.current.id !== cut.chat.id || shown.current.messages !== cut.chat.messages) return;
        // A new call, so it goes with the settings and the key as they are now: a parent may have
        // changed the provider, the model or the instructions, or taken the key away, meanwhile.
        settings = services.loadSettings();
        apiKey = services.loadApiKey(settings.provider);
        if (!isReady(forMode) || missingFor(forMode, settings, apiKey)) {
          // Nothing to ask with any more: she gets the usual notice, and what was cut stays.
          setNotice({ kind: 'error', reason: cut.reason });
          return;
        }
        // What was cut is replaced by the new answer, and comes back if the new call brings nothing.
        replaced = cut.chat.messages.slice(base.messages.length);
        countOnFirstPiece = cut.countOnFirstPiece;
      }
    },
    [services, attempt, backOnScreen],
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
    (text: string, attachment?: Attachment): boolean => {
      const mine = text.trim();
      if (!mine || busy.current || !isReady(mode)) return false;
      const settings = services.loadSettings();
      const apiKey = services.loadApiKey(settings.provider);
      if (missingFor(mode, settings, apiKey)) return false;
      // A file goes only in the modes that take one, and only when the parent chose a model for files.
      if (attachment && (!canAttachIn(mode) || !settings.fileModel)) return false;

      if (overLimit(settings)) return false;
      const base = withMessage(shown.current, { id: services.newId(), role: 'user', text: cut(mine, MAX_MESSAGE_CHARS), at: services.now(), mode, ...(attachment ? { attachment } : {}) });
      count();
      show(base);
      keep(base, true, settings.parentUse === true);
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
      // What is on the screen now is exactly what is on the phone, whatever was said of this chat before.
      setUnsavedId((unsaved) => (unsaved === found.id ? null : unsaved));
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
