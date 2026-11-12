import type { ChatSummary } from './chat';

export interface DayGroup {
  label: string;
  chats: ChatSummary[];
}

const LABELS = ['היום', 'אתמול', 'השבוע', 'קודם'] as const;

/**
 * The list of chats under day headings, by the phone's own calendar days: today, yesterday,
 * the five days before, and everything older. The order inside a group is the order given
 * (most recently used first). Empty groups are left out.
 */
export function groupByDay(chats: readonly ChatSummary[], now: number): DayGroup[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  // Counted in calendar days, not hours: a day is 23 or 25 hours long when the clocks change.
  const daysAgo = (days: number) => {
    const day = new Date(midnight);
    day.setDate(day.getDate() - days);
    return day.getTime();
  };
  const starts = [midnight.getTime(), daysAgo(1), daysAgo(6)];
  const groups: DayGroup[] = LABELS.map((label) => ({ label, chats: [] }));
  for (const chat of chats) {
    const index = starts.findIndex((start) => chat.updatedAt >= start);
    groups[index === -1 ? 3 : index].chats.push(chat);
  }
  return groups.filter((group) => group.chats.length > 0);
}
