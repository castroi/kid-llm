import { describe, expect, it } from 'vitest';
import type { AiErrorReason } from '../ai/providers';
import { parentMessage, waitText } from './parentMessages';

const REASONS: AiErrorReason[] = ['unauthorized', 'no-credit', 'rate-limited', 'bad-request', 'provider-down', 'refused', 'network', 'timeout', 'cancelled', 'bad-response'];

describe('what the parent is told', () => {
  it('has a Hebrew line for every way a call can fail', () => {
    for (const reason of REASONS) expect(parentMessage(reason)).toMatch(/[א-ת]/);
  });

  it('points at the thing to fix', () => {
    expect(parentMessage('unauthorized')).toContain('המפתח');
    expect(parentMessage('no-credit')).toContain('היתרה');
    expect(parentMessage('bad-request')).toContain('שם המודל');
    expect(parentMessage('network')).toContain('האינטרנט');
  });

  it('says how long a lock lasts in seconds or minutes, rounded up', () => {
    expect(waitText(1)).toBe('1 שניות');
    expect(waitText(30_000)).toBe('30 שניות');
    expect(waitText(60_000)).toBe('דקה');
    expect(waitText(61_000)).toBe('2 דקות');
    expect(waitText(60 * 60_000)).toBe('60 דקות');
  });
});
