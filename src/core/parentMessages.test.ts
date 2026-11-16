import { describe, expect, it } from 'vitest';
import type { AiErrorReason } from '../ai/providers';
import { chatsText, importText, parentMessage, sizeText, waitText } from './parentMessages';

const REASONS: AiErrorReason[] = ['unauthorized', 'no-credit', 'rate-limited', 'bad-request', 'provider-down', 'refused', 'network', 'timeout', 'cancelled', 'not-verified', 'bad-response'];

describe('what the parent is told', () => {
  it('has a Hebrew line for every way a call can fail', () => {
    for (const reason of REASONS) expect(parentMessage(reason)).toMatch(/[א-ת]/);
  });

  it('points at the thing to fix', () => {
    expect(parentMessage('unauthorized')).toContain('המפתח');
    expect(parentMessage('no-credit')).toContain('היתרה');
    expect(parentMessage('bad-request')).toContain('שם המודל');
    expect(parentMessage('network')).toContain('האינטרנט');
    expect(parentMessage('not-verified')).toContain('attestation');
    expect(parentMessage('not-verified')).toContain('לא נשלחה');
  });

  it('says how long a lock lasts in seconds or minutes, rounded up', () => {
    expect(waitText(1)).toBe('1 שניות');
    expect(waitText(30_000)).toBe('30 שניות');
    expect(waitText(60_000)).toBe('דקה');
    expect(waitText(61_000)).toBe('2 דקות');
    expect(waitText(60 * 60_000)).toBe('60 דקות');
  });

  it('counts chats and sizes in words a parent reads', () => {
    expect(chatsText(1)).toBe('שיחה אחת');
    expect(chatsText(12)).toBe('12 שיחות');
    expect(sizeText(10)).toBe('1 KB');
    expect(sizeText(340 * 1024)).toBe('340 KB');
    expect(sizeText(3.44 * 1024 * 1024)).toBe('3.4 MB');
  });

  it('says what an import did: what was added, what was left alone, and where it stopped', () => {
    const none = { addedParent: 0, kept: 0, unreadable: 0, ended: 'whole' as const };
    expect(importText({ ...none, added: 3 })).toBe('נוספו 3 שיחות, כולן שלה.');
    expect(importText({ ...none, added: 1, kept: 1, unreadable: 1 })).toBe('נוספה שיחה אחת, שלה. שיחה אחת כבר הייתה באייפון ולא שונתה. רשומה אחת בקובץ היא לא שיחה, ודילגנו עליה.');
    expect(importText({ ...none, added: 0, kept: 4, unreadable: 2 })).toBe('לא נוספו שיחות. 4 שיחות כבר היו באייפון ולא שונו. 2 רשומות בקובץ הן לא שיחות, ודילגנו עליהן.');
    expect(importText({ ...none, added: 2, ended: 'cut' })).toBe('נוספו 2 שיחות, כולן שלה. הקובץ קטוע או פגום, ולכן השיחות שבסופו לא יובאו. השיחות שלפני כן נוספו.');
    expect(importText({ ...none, added: 2, ended: 'not-saved' })).toContain('האחסון מלא');
  });

  it("tells her chats from a parent's own in what was added, so a changed mark is noticed", () => {
    const none = { kept: 0, unreadable: 0, ended: 'whole' as const };
    expect(importText({ ...none, added: 1, addedParent: 1 })).toBe('נוספה שיחה אחת, של מצב הורים.');
    expect(importText({ ...none, added: 4, addedParent: 4 })).toBe('נוספו 4 שיחות, כולן של מצב הורים.');
    expect(importText({ ...none, added: 5, addedParent: 2 })).toBe('נוספו 5 שיחות: 3 שלה ו-2 של מצב הורים.');
  });
});
