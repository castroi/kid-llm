import { describe, expect, it } from 'vitest';
import type { AiErrorReason } from '../ai/providers';
import { attachmentMessage, kidMessage, limitMessage, pickMessage } from './kidMessages';

const ALL: AiErrorReason[] = ['unauthorized', 'no-credit', 'rate-limited', 'bad-request', 'provider-down', 'refused', 'network', 'timeout', 'cancelled', 'not-verified', 'bad-response'];

describe('kidMessage', () => {
  it('offers to try again only when trying again can help', () => {
    for (const reason of ['network', 'timeout', 'rate-limited', 'provider-down', 'bad-response'] as const) {
      expect(kidMessage(reason).retry, reason).toBe(true);
    }
    for (const reason of ['unauthorized', 'no-credit', 'bad-request', 'refused'] as const) {
      expect(kidMessage(reason).retry, reason).toBe(false);
    }
  });

  it('sends her to a parent for what only a parent can fix', () => {
    for (const reason of ['unauthorized', 'no-credit', 'bad-request', 'not-verified'] as const) {
      expect(kidMessage(reason).text).toBe('משהו לא עובד. כדאי לקרוא לאבא או לאמא.');
    }
  });

  it('is always one line of Hebrew with no code, number or English in it', () => {
    for (const reason of ALL) {
      const { text } = kidMessage(reason);
      expect(text, reason).toMatch(/^[֐-׿ .,!?'"-]+$/);
    }
  });
});

describe('attachmentMessage', () => {
  it('is one friendly line of Hebrew for each problem, each different', () => {
    const texts = (['unsupported', 'too-large', 'unreadable'] as const).map(attachmentMessage);
    for (const text of texts) expect(text).toMatch(/^[֐-׿ .,!?'"-]+$/);
    expect(new Set(texts).size).toBe(3);
  });
});

describe('the line about files she picked', () => {
  const result = { picked: 1, added: 1, limits: [], failed: [], pictureLimit: 5 } as const;

  it('is empty when every file was attached', () => {
    expect(pickMessage(result)).toBe('');
    expect(pickMessage({ ...result, picked: 4, added: 4 })).toBe('');
  });

  it("is the file's own line when she picked one", () => {
    expect(pickMessage({ ...result, added: 0, failed: ['too-large'] })).toBe(attachmentMessage('too-large'));
    expect(pickMessage({ ...result, added: 0, limits: ['pictures'], pictureLimit: 1 })).toBe('אפשר לצרף רק תמונה אחת להודעה.');
  });

  it('says how many were attached and why the others were not', () => {
    expect(pickMessage({ picked: 6, added: 4, limits: ['pictures', 'pictures'], failed: [], pictureLimit: 4 })).toBe('צירפתי 4 מתוך 6. אפשר לצרף עד 4 תמונות להודעה.');
    expect(pickMessage({ picked: 3, added: 1, limits: ['documents'], failed: ['unreadable'], pictureLimit: 5 })).toBe('צירפתי קובץ אחד מתוך 3. אפשר לצרף עד 5 מסמכים להודעה. קובץ אחד לא נפתח.');
    expect(pickMessage({ picked: 3, added: 0, limits: [], failed: ['unreadable', 'unsupported', 'unreadable'], pictureLimit: 5 })).toBe('3 קבצים לא נפתחו.');
  });

  it('names each limit in Hebrew', () => {
    expect(limitMessage('pictures', 3)).toBe('אפשר לצרף עד 3 תמונות להודעה.');
    expect(limitMessage('size', 5)).toMatch(/גדולים מדי/);
  });
});
