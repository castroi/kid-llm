// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ATTEMPTS_KEY, checkPin, FIRST_LOCK_MS, hasPin, lockedFor, lockMs, MAX_LOCK_MS, MAX_TRIES, PIN_KEY, setPin } from './pin';

function memory(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
  };
}

const NOW = 1_800_000_000_000;

async function wrongTries(count: number, storage: ReturnType<typeof memory>, now = NOW) {
  const results = [];
  for (let i = 0; i < count; i++) results.push(await checkPin('0000', now, storage));
  return results;
}

describe("the parent's code", () => {
  it('does not exist until a parent chooses one', async () => {
    const storage = memory();
    expect(hasPin(storage)).toBe(false);
    expect(await checkPin('1234', NOW, storage)).toBe('wrong');
  });

  it('accepts the right code and refuses a wrong one', async () => {
    const storage = memory();
    expect(await setPin('4821', storage)).toBe(true);
    expect(hasPin(storage)).toBe(true);
    expect(await checkPin('4821', NOW, storage)).toBe('ok');
    expect(await checkPin('4822', NOW, storage)).toBe('wrong');
    expect(await checkPin('', NOW, storage)).toBe('wrong');
  });

  it('is 4 to 8 digits and nothing else', async () => {
    const storage = memory();
    for (const bad of ['', '123', '123456789', 'abcd', '12 34', '１２３４']) {
      expect(await setPin(bad, storage), bad).toBe(false);
    }
    expect(hasPin(storage)).toBe(false);
    expect(await setPin('12345678', storage)).toBe(true);
  });

  it('is never stored itself: only a salted hash, different each time', async () => {
    const first = memory();
    const second = memory();
    await setPin('4821', first);
    await setPin('4821', second);
    const record = JSON.parse(first.entries.get(PIN_KEY)!);
    expect(first.entries.get(PIN_KEY)).not.toContain('4821');
    expect(record.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.hash).not.toBe(JSON.parse(second.entries.get(PIN_KEY)!).hash);
  });

  it('can be replaced by a new one', async () => {
    const storage = memory();
    await setPin('4821', storage);
    await setPin('9000', storage);
    expect(await checkPin('4821', NOW, storage)).toBe('wrong');
    expect(await checkPin('9000', NOW, storage)).toBe('ok');
  });
});

describe('wrong tries', () => {
  it(`lock the parent area for a minute after ${MAX_TRIES} in a row, and the right code does not help meanwhile`, async () => {
    const storage = memory();
    await setPin('4821', storage);
    expect(await wrongTries(MAX_TRIES, storage)).toEqual(['wrong', 'wrong', 'wrong', 'wrong', 'locked']);
    expect(lockedFor(NOW, storage)).toBe(FIRST_LOCK_MS);
    expect(await checkPin('4821', NOW + 1_000, storage)).toBe('locked');
    expect(lockedFor(NOW + FIRST_LOCK_MS, storage)).toBe(0);
    expect(await checkPin('4821', NOW + FIRST_LOCK_MS, storage)).toBe('ok');
  });

  it('lock for twice as long after each further wrong try, up to an hour', async () => {
    const storage = memory();
    await setPin('4821', storage);
    await wrongTries(MAX_TRIES, storage);
    let now = NOW + FIRST_LOCK_MS;
    expect(await checkPin('0000', now, storage)).toBe('locked');
    expect(lockedFor(now, storage)).toBe(2 * FIRST_LOCK_MS);
    now += 2 * FIRST_LOCK_MS;
    expect(await checkPin('0000', now, storage)).toBe('locked');
    expect(lockedFor(now, storage)).toBe(4 * FIRST_LOCK_MS);
    expect(lockMs(MAX_TRIES - 1)).toBe(0);
    expect(lockMs(MAX_TRIES + 30)).toBe(MAX_LOCK_MS);
    expect(lockMs(10_000)).toBe(MAX_LOCK_MS);
  });

  it('are forgotten after the right code, and after a new code is set', async () => {
    const storage = memory();
    await setPin('4821', storage);
    await wrongTries(MAX_TRIES - 1, storage);
    expect(await checkPin('4821', NOW, storage)).toBe('ok');
    expect(storage.entries.has(ATTEMPTS_KEY)).toBe(false);
    expect(await wrongTries(MAX_TRIES - 1, storage)).toEqual(['wrong', 'wrong', 'wrong', 'wrong']);

    await wrongTries(1, storage);
    expect(lockedFor(NOW, storage)).toBeGreaterThan(0);
    await setPin('9000', storage);
    expect(lockedFor(NOW, storage)).toBe(0);
  });

  it('never lock for longer than an hour, whatever the record says', async () => {
    const storage = memory({ [ATTEMPTS_KEY]: JSON.stringify({ failed: 3, lockedUntil: NOW * 10 }) });
    expect(lockedFor(NOW, storage)).toBe(MAX_LOCK_MS);
  });
});

describe('a record that cannot be trusted', () => {
  it('counts as no code at all', async () => {
    for (const stored of ['{not json', 'null', '7', '{"salt":"zz","hash":"x","iterations":1}', `{"salt":"${'a'.repeat(32)}","hash":"${'b'.repeat(64)}","iterations":1e12}`, `{"salt":"${'a'.repeat(32)}","hash":"${'b'.repeat(64)}"}`]) {
      const storage = memory({ [PIN_KEY]: stored });
      expect(hasPin(storage), stored).toBe(false);
      expect(await checkPin('1234', NOW, storage)).toBe('wrong');
    }
  });

  it('counts unreadable tries as none', async () => {
    const storage = memory({ [ATTEMPTS_KEY]: '{"failed":"many","lockedUntil":"later"}' });
    await setPin('4821', storage);
    storage.entries.set(ATTEMPTS_KEY, '{"failed":"many","lockedUntil":"later"}');
    expect(lockedFor(NOW, storage)).toBe(0);
    expect(await checkPin('0000', NOW, storage)).toBe('wrong');
  });
});

describe('a phone that refuses to save', () => {
  const refusing = (initial: Record<string, string> = {}) => ({
    ...memory(initial),
    setItem: () => {
      throw new Error('full');
    },
    removeItem: () => {
      throw new Error('full');
    },
  });

  it('cannot take a new code', async () => {
    expect(await setPin('4821', refusing())).toBe(false);
  });

  it('still tells a right code from a wrong one', async () => {
    const good = memory();
    await setPin('4821', good);
    const storage = refusing({ [PIN_KEY]: good.entries.get(PIN_KEY)! });
    expect(await checkPin('4821', NOW, storage)).toBe('ok');
    expect(await checkPin('0000', NOW, storage)).toBe('wrong');
  });

  it('still locks after too many wrong tries, counting them in memory', async () => {
    const good = memory();
    await setPin('4821', good);
    const storage = refusing({ [PIN_KEY]: good.entries.get(PIN_KEY)! });
    expect(await wrongTries(MAX_TRIES, storage)).toEqual(['wrong', 'wrong', 'wrong', 'wrong', 'locked']);
    expect(lockedFor(NOW, storage)).toBe(FIRST_LOCK_MS); // nothing could be written, the lock is in memory
    expect(await checkPin('4821', NOW, storage)).toBe('locked'); // so the right code waits too
    expect(await checkPin('4821', NOW + FIRST_LOCK_MS, storage)).toBe('ok');
  });
});

describe('tries that start together', () => {
  it('are checked one at a time, so only the allowed number is checked before the lock', async () => {
    const storage = memory();
    await setPin('4821', storage);
    const results = await Promise.all(Array.from({ length: 12 }, () => checkPin('0000', NOW, storage)));
    expect(results.filter((r) => r === 'wrong')).toHaveLength(MAX_TRIES - 1);
    expect(results.filter((r) => r === 'locked')).toHaveLength(12 - MAX_TRIES + 1);
    // The tries made after the lock were not checked or counted.
    expect(JSON.parse(storage.entries.get(ATTEMPTS_KEY)!).failed).toBe(MAX_TRIES);
  });

  it('cannot slip the right code in among wrong ones once the lock has started', async () => {
    const storage = memory();
    await setPin('4821', storage);
    const tries = [...Array.from({ length: MAX_TRIES }, () => '0000'), '4821'];
    const results = await Promise.all(tries.map((pin) => checkPin(pin, NOW, storage)));
    expect(results.at(-1)).toBe('locked');
  });
});
