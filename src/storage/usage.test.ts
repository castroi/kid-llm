import { describe, expect, it } from 'vitest';
import { countMessage, sentToday, USAGE_KEY } from './usage';

function memory(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
  };
}

const at = (day: number, hours: number, minutes = 0) => new Date(2026, 10, day, hours, minutes).getTime();

describe('daily usage', () => {
  it('starts at zero and counts each message she sends', () => {
    const storage = memory();
    expect(sentToday(at(11, 9), storage)).toBe(0);
    expect(countMessage(at(11, 9), storage)).toBe(true);
    countMessage(at(11, 15), storage);
    expect(sentToday(at(11, 23, 59), storage)).toBe(2);
  });

  it("starts again on the next day, by the phone's own clock", () => {
    const storage = memory();
    countMessage(at(11, 23, 59), storage);
    expect(sentToday(at(12, 0, 1), storage)).toBe(0);
    countMessage(at(12, 8), storage);
    expect(sentToday(at(12, 9), storage)).toBe(1);
  });

  it('does not start a new day when the clock is set back', () => {
    const storage = memory();
    countMessage(at(11, 18), storage);
    countMessage(at(11, 19), storage);
    // The clock now says yesterday, or last week.
    expect(sentToday(at(10, 12), storage)).toBe(2);
    countMessage(at(4, 12), storage);
    expect(sentToday(at(11, 20), storage)).toBe(3);
  });

  it('holds only the day and a number: no message text', () => {
    const storage = memory();
    countMessage(at(11, 9), storage);
    expect(JSON.parse(storage.entries.get(USAGE_KEY)!)).toEqual({ day: '2026-11-11', count: 1, lastSeen: at(11, 9) });
  });

  it('treats a record it cannot read as no record', () => {
    for (const stored of ['{not json', 'null', '7', '{"day":5,"count":1,"lastSeen":1}', '{"day":"2026-11-11","count":"many","lastSeen":1}', '{"day":"2026-11-11","count":1}']) {
      expect(sentToday(at(11, 9), memory({ [USAGE_KEY]: stored }))).toBe(0);
    }
  });

  it('says so when the browser refuses to save, and counts nothing', () => {
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(countMessage(at(11, 9), refusing)).toBe(false);
    expect(sentToday(at(11, 9), refusing)).toBe(0);
    const unreadable = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => undefined,
    };
    expect(sentToday(at(11, 9), unreadable)).toBe(0);
  });
});
