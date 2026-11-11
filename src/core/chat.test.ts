import { describe, expect, it } from 'vitest';
import { newChat, sentOnDayOf, titleFrom, toProviderMessages, UNTITLED, withMessage, withUpdatedMessage, type StoredMessage } from './chat';

let counter = 0;
function message(role: StoredMessage['role'], text: string, extra: Partial<StoredMessage> = {}): StoredMessage {
  counter += 1;
  return { id: `m${counter}`, role, text, at: 1_000 + counter, mode: 'chat', ...extra };
}

describe('a chat', () => {
  it('starts empty and unnamed, in the mode she chose', () => {
    expect(newChat('math', 500, 'c1')).toEqual({ id: 'c1', title: UNTITLED, mode: 'math', createdAt: 500, updatedAt: 500, messages: [] });
    expect(newChat('chat', 1).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is named after her first message, and keeps that name afterwards', () => {
    const first = withMessage(newChat('chat', 0, 'c1'), message('user', 'למה השמיים כחולים?'));
    expect(first.title).toBe('למה השמיים כחולים?');
    const later = withMessage(withMessage(first, message('assistant', 'בגלל פיזור האור')), message('user', 'ולמה השקיעה אדומה?'));
    expect(later.title).toBe('למה השמיים כחולים?');
    expect(later.messages).toHaveLength(3);
  });

  it('follows the mode of the newest message and the time of the newest change', () => {
    const chat = withMessage(newChat('chat', 0, 'c1'), message('user', 'כמה זה 2+2?', { mode: 'math', at: 9_000 }));
    expect(chat.mode).toBe('math');
    expect(chat.updatedAt).toBe(9_000);
  });

  it('does not change the chat it was given', () => {
    const chat = newChat('chat', 0, 'c1');
    withMessage(chat, message('user', 'היי'));
    expect(chat.messages).toEqual([]);
    expect(chat.title).toBe(UNTITLED);
  });

  it('replaces an answer while it is being written', () => {
    const answer = message('assistant', 'ה');
    const chat = withMessage(withMessage(newChat('chat', 0, 'c1'), message('user', 'היי')), answer);
    const updated = withUpdatedMessage(chat, { ...answer, text: 'היי לך!', state: 'stopped' });
    expect(updated.messages[1]).toMatchObject({ id: answer.id, text: 'היי לך!', state: 'stopped' });
    expect(updated.messages).toHaveLength(2);
  });
});

describe('titleFrom', () => {
  it('uses one line, cut to a readable length', () => {
    expect(titleFrom('  שלום\n\nעולם  ')).toBe('שלום עולם');
    const long = titleFrom('א'.repeat(100));
    expect(long).toHaveLength(41);
    expect(long.endsWith('…')).toBe(true);
    expect(titleFrom('   ')).toBe(UNTITLED);
  });
});

describe('toProviderMessages', () => {
  it('sends the whole conversation, oldest first', () => {
    const messages = [message('user', 'א'), message('assistant', 'ב'), message('user', 'ג')];
    expect(toProviderMessages(messages)).toEqual([
      { role: 'user', content: 'א' },
      { role: 'assistant', content: 'ב' },
      { role: 'user', content: 'ג' },
    ]);
  });

  it('leaves out failed and empty answers, and keeps an answer she stopped', () => {
    const messages = [
      message('user', 'א'),
      message('assistant', '', { state: 'failed' }),
      message('user', 'ב'),
      message('assistant', 'חצי תשובה', { state: 'stopped' }),
      message('assistant', '   '),
      message('user', 'ג'),
    ];
    expect(toProviderMessages(messages).map((m) => m.content)).toEqual(['א', 'ב', 'חצי תשובה', 'ג']);
  });

  it('drops the oldest messages of a long conversation, never her newest one', () => {
    const messages = [message('user', 'a'.repeat(50)), message('assistant', 'b'.repeat(50)), message('user', 'c'.repeat(50)), message('assistant', 'd'.repeat(50)), message('user', 'e'.repeat(50))];
    expect(toProviderMessages(messages, 120).map((m) => m.content[0])).toEqual(['e']);
    expect(toProviderMessages(messages, 150).map((m) => m.content[0])).toEqual(['c', 'd', 'e']);
    // Longer than the whole budget: it still goes.
    expect(toProviderMessages([message('user', 'x'.repeat(500))], 100)).toHaveLength(1);
  });

  it("doesn't open with an answer whose question was dropped", () => {
    const messages = [message('user', 'a'.repeat(50)), message('assistant', 'b'.repeat(50)), message('user', 'c'.repeat(50))];
    expect(toProviderMessages(messages, 100).map((m) => m.role)).toEqual(['user']);
  });
});

describe('sentOnDayOf', () => {
  it("counts only her own messages, only on that day by the phone's clock", () => {
    const noon = new Date(2026, 10, 11, 12, 0).getTime();
    const at = (hours: number, day = 11) => new Date(2026, 10, day, hours, 0).getTime();
    const chats = [
      { messages: [message('user', 'א', { at: at(0) }), message('assistant', 'ב', { at: at(1) }), message('user', 'ג', { at: at(23) })] },
      { messages: [message('user', 'אתמול', { at: at(23, 10) }), message('user', 'מחר', { at: at(0, 12) })] },
    ];
    expect(sentOnDayOf(noon, chats)).toBe(2);
    expect(sentOnDayOf(noon, [])).toBe(0);
  });
});
