/**
 * The parent's code for the parent area. It keeps a 10-year-old out of the settings; it is
 * not strong protection against someone with tools: the code is 4 to 8 digits, and whoever
 * can read the phone's storage can try them all. Only a salted, slow hash of the code is
 * kept, never the code.
 *
 * Wrong tries are counted on the phone. After 5 in a row the area locks for a minute, and
 * for twice as long after each further wrong try, up to an hour. Setting the phone's clock
 * forward ends a lock early; it still leaves one try per lock.
 *
 * If the code is forgotten, clearing the site's data in Safari removes it together with
 * the key and the settings: she can't chat until a parent sets the app up again.
 */
export const PIN_KEY = 'kid-llm.pin.v1';
export const ATTEMPTS_KEY = 'kid-llm.pin-attempts.v1';
export const PIN_PATTERN = /^\d{4,8}$/;
export const MAX_TRIES = 5;
export const FIRST_LOCK_MS = 60_000;
export const MAX_LOCK_MS = 60 * 60_000;
const ITERATIONS = 150_000;
const MAX_ITERATIONS = 5_000_000;

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Hasher = Pick<Crypto, 'getRandomValues' | 'subtle'>;

interface PinRecord {
  salt: string;
  hash: string;
  iterations: number;
}

interface Attempts {
  failed: number;
  lockedUntil: number;
}

export type PinResult = 'ok' | 'wrong' | 'locked';

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

async function derive(pin: string, salt: Uint8Array, iterations: number, hasher: Hasher): Promise<string> {
  const key = await hasher.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await hasher.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return toHex(new Uint8Array(bits));
}

function readJson(storage: KeyValue, key: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? 'null');
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readRecord(storage: KeyValue): PinRecord | null {
  const value = readJson(storage, PIN_KEY);
  if (!value) return null;
  const { salt, hash, iterations } = value;
  if (typeof salt !== 'string' || !/^[0-9a-f]{32}$/.test(salt)) return null;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return null;
  if (typeof iterations !== 'number' || !Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) return null;
  return { salt, hash, iterations };
}

function readAttempts(storage: KeyValue): Attempts {
  const value = readJson(storage, ATTEMPTS_KEY);
  const failed = value?.failed;
  const lockedUntil = value?.lockedUntil;
  return {
    failed: typeof failed === 'number' && Number.isInteger(failed) && failed > 0 ? failed : 0,
    lockedUntil: typeof lockedUntil === 'number' && Number.isFinite(lockedUntil) ? lockedUntil : 0,
  };
}

/** How long a lock lasts after `failed` wrong tries in a row. */
export function lockMs(failed: number): number {
  if (failed < MAX_TRIES) return 0;
  return Math.min(FIRST_LOCK_MS * 2 ** Math.min(failed - MAX_TRIES, 20), MAX_LOCK_MS);
}

/** Whether a parent has chosen a code. Until then the parent area asks for one. */
export function hasPin(storage: KeyValue = localStorage): boolean {
  return readRecord(storage) !== null;
}

/** Saves a new code (4 to 8 digits) and forgets earlier wrong tries. False when the code isn't valid or can't be saved. */
export async function setPin(pin: string, storage: KeyValue = localStorage, hasher: Hasher = crypto): Promise<boolean> {
  if (!PIN_PATTERN.test(pin)) return false;
  try {
    const salt = hasher.getRandomValues(new Uint8Array(16));
    const record: PinRecord = { salt: toHex(salt), hash: await derive(pin, salt, ITERATIONS, hasher), iterations: ITERATIONS };
    storage.setItem(PIN_KEY, JSON.stringify(record));
    storage.removeItem(ATTEMPTS_KEY);
    return true;
  } catch {
    return false;
  }
}

/** How many milliseconds the parent area stays locked; 0 when it isn't. */
export function lockedFor(now: number, storage: KeyValue = localStorage): number {
  const { lockedUntil } = readAttempts(storage);
  // A lock is never longer than the longest one, whatever the clock or the record says.
  return Math.max(0, Math.min(lockedUntil - now, MAX_LOCK_MS));
}

/** Checks a code. A wrong try is counted; `locked` means no check was made at all. */
export async function checkPin(pin: string, now: number, storage: KeyValue = localStorage, hasher: Hasher = crypto): Promise<PinResult> {
  if (lockedFor(now, storage) > 0) return 'locked';
  const record = readRecord(storage);
  let right = false;
  if (record && PIN_PATTERN.test(pin)) {
    try {
      right = (await derive(pin, fromHex(record.salt), record.iterations, hasher)) === record.hash;
    } catch {
      right = false;
    }
  }
  try {
    if (right) {
      storage.removeItem(ATTEMPTS_KEY);
      return 'ok';
    }
    const failed = readAttempts(storage).failed + 1;
    const wait = lockMs(failed);
    storage.setItem(ATTEMPTS_KEY, JSON.stringify({ failed, lockedUntil: wait > 0 ? now + wait : 0 }));
    return wait > 0 ? 'locked' : 'wrong';
  } catch {
    // The phone refused to write: the answer is still the truth, the count just isn't kept.
    return right ? 'ok' : 'wrong';
  }
}
