import type { ChatMessage } from '../ai/providers';
import { MODES, type ModeId } from './modes';
import { cut } from './text';

/** One message as it is kept on the phone. */
export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** When it was written, in milliseconds since 1970. */
  at: number;
  /** The mode she was in; shown under an answer instead of a model name. */
  mode: ModeId;
  /**
   * How an answer ended, when it didn't end normally:
   * `stopped` she pressed "עצירה" (the text so far is kept); `failed` the call failed.
   */
  state?: 'stopped' | 'failed';
}

/** One conversation, kept whole in one record on the phone. */
export interface Chat {
  id: string;
  title: string;
  /** The mode she last used in it. */
  mode: ModeId;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

/** What the list of chats shows. No messages, but `title` is the start of her first message, so it is hers too. */
export type ChatSummary = Pick<Chat, 'id' | 'title' | 'mode' | 'createdAt' | 'updatedAt'>;

export const UNTITLED = 'שיחה חדשה';
const TITLE_CHARS = 40;

export function newChat(mode: ModeId, now: number, id: string = crypto.randomUUID()): Chat {
  return { id, title: UNTITLED, mode, createdAt: now, updatedAt: now, messages: [] };
}

/** A chat's name in the list: the start of her first message, on one line. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return UNTITLED;
  return line.length > TITLE_CHARS ? `${cut(line, TITLE_CHARS).trimEnd()}…` : line;
}

/** Adds a message; the chat is named after her first one. Returns a new chat, the old one is untouched. */
export function withMessage(chat: Chat, message: StoredMessage): Chat {
  const first = message.role === 'user' && !chat.messages.some((m) => m.role === 'user');
  return {
    ...chat,
    title: first && chat.title === UNTITLED ? titleFrom(message.text) : chat.title,
    mode: message.mode,
    updatedAt: Math.max(chat.updatedAt, message.at),
    messages: [...chat.messages, message],
  };
}

/** Replaces the message with the same id (an answer while it is being written). */
export function withUpdatedMessage(chat: Chat, message: StoredMessage): Chat {
  return { ...chat, updatedAt: Math.max(chat.updatedAt, message.at), messages: chat.messages.map((m) => (m.id === message.id ? message : m)) };
}

/** The longest message she can send; the input box stops there, and so does every call. */
export const MAX_MESSAGE_CHARS = 4_000;

/**
 * The most text sent in one call. The provider keeps nothing between calls, so every
 * call resends the conversation; this bounds what a long chat costs and keeps it inside
 * a model's limit. Counted in characters (about 4 per token in English, fewer in Hebrew).
 */
export const MAX_CONTEXT_CHARS = 24_000;

/**
 * The conversation as it is sent to the provider: oldest first, ending with her newest
 * message. Left out: answers that failed, empty messages, and anything that is not hers
 * or an answer (a stored record can't add instructions of its own). Messages in a row
 * from the same side are joined, because some models refuse two in a row. When the
 * conversation is longer than `maxChars`, the oldest messages are dropped; her newest
 * always goes, cut to `maxChars`. Empty when there is nothing of hers to answer.
 */
export function toProviderMessages(messages: readonly StoredMessage[], maxChars: number = MAX_CONTEXT_CHARS): ChatMessage[] {
  const known = messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string');
  // Only a conversation that ends with a message of hers has something to answer; an
  // earlier question that already got its answer is never sent again on its own.
  const newest = known[known.length - 1];
  if (!newest || newest.role !== 'user' || newest.text.trim() === '') return [];
  const usable = known.filter((m) => m.text.trim() !== '' && m.state !== 'failed');

  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = usable.length - 1; i >= 0; i--) {
    const { role } = usable[i];
    const content = cut(usable[i].text, maxChars);
    if (kept.length > 0 && used + content.length > maxChars) break;
    used += content.length;
    if (kept[0]?.role === role) kept[0] = { role, content: `${content}\n\n${kept[0].content}` };
    else kept.unshift({ role, content });
  }
  // A conversation can't open with an answer whose question was dropped.
  while (kept.length > 1 && kept[0].role === 'assistant') kept.shift();
  return kept;
}

const MODE_IDS: readonly string[] = MODES.map((m) => m.id);
const isMode = (value: unknown): value is ModeId => typeof value === 'string' && MODE_IDS.includes(value);
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * A chat as it may be used, made from whatever was stored or imported: unknown fields
 * are dropped (an `apiKey` can't ride along), messages that aren't hers or an answer are
 * dropped, wrong types fall back. null when it isn't a chat at all. Never throws.
 */
export function sanitizeChat(raw: unknown): Chat | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || !value.id || !isTime(value.createdAt)) return null;
  const mode = isMode(value.mode) ? value.mode : 'chat';
  const messages: StoredMessage[] = [];
  for (const item of Array.isArray(value.messages) ? value.messages : []) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.id !== 'string' || typeof m.text !== 'string') continue;
    const message: StoredMessage = { id: m.id, role: m.role, text: m.text, at: isTime(m.at) ? m.at : value.createdAt, mode: isMode(m.mode) ? m.mode : mode };
    if (m.state === 'stopped' || m.state === 'failed') message.state = m.state;
    messages.push(message);
  }
  return {
    id: value.id,
    title: typeof value.title === 'string' && value.title.trim() ? titleFrom(value.title) : UNTITLED,
    mode,
    createdAt: value.createdAt,
    updatedAt: isTime(value.updatedAt) ? value.updatedAt : value.createdAt,
    messages,
  };
}
