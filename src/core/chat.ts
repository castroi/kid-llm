import type { ChatMessage } from '../ai/providers';
import type { ModeId } from './modes';

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

/** What the list of chats shows; no message text. */
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
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS).trimEnd()}…` : line;
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

/**
 * The most text of earlier messages sent with a new one. The provider keeps nothing
 * between calls, so every call resends the conversation; this bounds what a long chat
 * costs and keeps it inside a model's limit. Counted in characters (about 4 per token
 * in English, fewer in Hebrew).
 */
export const MAX_CONTEXT_CHARS = 24_000;

/**
 * The conversation as it is sent to the provider: oldest first, ending with her newest
 * message. Answers that failed, and empty ones, are left out. When the conversation is
 * longer than `maxChars`, the oldest messages are dropped; her newest message always goes.
 */
export function toProviderMessages(messages: readonly StoredMessage[], maxChars: number = MAX_CONTEXT_CHARS): ChatMessage[] {
  const usable = messages.filter((m) => m.text.trim() !== '' && m.state !== 'failed');
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = usable.length - 1; i >= 0; i--) {
    const { role, text } = usable[i];
    if (kept.length > 0 && used + text.length > maxChars) break;
    kept.unshift({ role, content: text });
    used += text.length;
  }
  // A conversation can't open with an answer whose question was dropped.
  while (kept.length > 1 && kept[0].role === 'assistant') kept.shift();
  return kept;
}

/** How many messages she sent on the day of `now` (the phone's own day), for the parent's daily limit. */
export function sentOnDayOf(now: number, chats: readonly Pick<Chat, 'messages'>[]): number {
  const day = new Date(now);
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  let count = 0;
  for (const chat of chats) {
    for (const m of chat.messages) {
      if (m.role === 'user' && m.at >= start && m.at < end) count++;
    }
  }
  return count;
}
