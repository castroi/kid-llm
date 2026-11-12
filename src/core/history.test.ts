import { describe, expect, it } from 'vitest';
import type { ChatSummary } from './chat';
import { groupByDay } from './history';

/** The phone's own time: Wednesday 11 November 2026, three in the afternoon. */
const NOW = new Date(2026, 10, 11, 15, 0).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const chat = (id: string, updatedAt: number): ChatSummary => ({ id, title: id, mode: 'chat', createdAt: updatedAt, updatedAt });

describe('the list of chats by day', () => {
  it('puts each chat under today, yesterday, this week or earlier, by calendar day', () => {
    const groups = groupByDay(
      [chat('now', NOW), chat('midnight', at(11, 0)), chat('last night', at(10, 23, 59)), chat('yesterday morning', at(10, 0)), chat('two days ago', at(9, 23, 59)), chat('six days ago', at(5, 0)), chat('a week ago', at(4, 23, 59))],
      NOW,
    );
    expect(groups.map((g) => [g.label, g.chats.map((c) => c.id)])).toEqual([
      ['היום', ['now', 'midnight']],
      ['אתמול', ['last night', 'yesterday morning']],
      ['השבוע', ['two days ago', 'six days ago']],
      ['קודם', ['a week ago']],
    ]);
  });

  it('leaves out a heading with no chats and keeps the order it was given', () => {
    const groups = groupByDay([chat('b', at(1, 9)), chat('a', at(1, 8))], NOW);
    expect(groups).toEqual([{ label: 'קודם', chats: [chat('b', at(1, 9)), chat('a', at(1, 8))] }]);
    expect(groupByDay([], NOW)).toEqual([]);
  });

  it('shows a chat dated in the future (the clock was set back) under today', () => {
    expect(groupByDay([chat('future', at(20, 9))], NOW)[0].label).toBe('היום');
  });
});
