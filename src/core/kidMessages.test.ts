import { describe, expect, it } from 'vitest';
import type { AiErrorReason } from '../ai/providers';
import { attachmentMessage, kidMessage } from './kidMessages';

const ALL: AiErrorReason[] = ['unauthorized', 'no-credit', 'rate-limited', 'bad-request', 'provider-down', 'refused', 'network', 'timeout', 'cancelled', 'bad-response'];

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
    for (const reason of ['unauthorized', 'no-credit', 'bad-request'] as const) {
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
