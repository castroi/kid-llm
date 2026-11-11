/**
 * How many messages she sent today, for the parent's daily limit. Kept as its own small
 * record on the phone, counted when a message is sent: deleting chats doesn't lower it,
 * and it holds no message text.
 *
 * The day is the phone's own. Setting the clock back doesn't start a new day (the record
 * remembers the latest time it saw); setting it forward does, and that can't be detected.
 */
export interface Usage {
  /** The phone's local day, "2026-11-11". */
  day: string;
  count: number;
  /** The latest time seen, so a clock set back is noticed. */
  lastSeen: number;
}

export const USAGE_KEY = 'kid-llm.usage.v1';

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

function dayOf(time: number): string {
  const date = new Date(time);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

function read(storage: KeyValue): Usage | null {
  try {
    const value = JSON.parse(storage.getItem(USAGE_KEY) ?? 'null') as Partial<Usage> | null;
    if (!value || typeof value.day !== 'string' || !Number.isSafeInteger(value.count) || !Number.isFinite(value.lastSeen)) return null;
    return { day: value.day, count: Math.max(0, value.count as number), lastSeen: value.lastSeen as number };
  } catch {
    return null;
  }
}

/** Today's record: the stored one if it is still the same day, otherwise a fresh one. */
function today(now: number, storage: KeyValue): Usage {
  const stored = read(storage);
  // A clock set back stays on the latest time already seen.
  const time = stored ? Math.max(now, stored.lastSeen) : now;
  const day = dayOf(time);
  return stored && stored.day === day ? { ...stored, lastSeen: time } : { day, count: 0, lastSeen: time };
}

/** How many messages she has sent today. */
export function sentToday(now: number, storage: KeyValue = localStorage): number {
  return today(now, storage).count;
}

/** Counts one more message for today. Returns false when the browser refused to save it. */
export function countMessage(now: number, storage: KeyValue = localStorage): boolean {
  const usage = today(now, storage);
  try {
    storage.setItem(USAGE_KEY, JSON.stringify({ ...usage, count: usage.count + 1 }));
    return true;
  } catch {
    return false;
  }
}
