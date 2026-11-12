/**
 * What she picks instead of a model. The parent decides which model is behind each
 * mode (parent area); she only ever sees these names.
 */
export type ModeId = 'chat' | 'search' | 'math' | 'draw';

export interface Mode {
  id: ModeId;
  name: string;
  /** One short line under the name, in her words. */
  description: string;
}

export const MODES: readonly Mode[] = [
  { id: 'chat', name: 'שיחה', description: 'לדבר על כל דבר' },
  { id: 'search', name: 'חיפוש', description: 'למצוא תשובות באינטרנט' },
  { id: 'math', name: 'חשבון', description: 'עזרה בתרגילים' },
  { id: 'draw', name: 'ציור', description: 'ליצור תמונה' },
];

/** She never has to choose before typing. */
export const DEFAULT_MODE: ModeId = 'chat';

/**
 * The modes that work today: all of them. A mode added to MODES before its provider call
 * exists is left out here; she then sees it marked "בקרוב" and can't pick it.
 */
export const READY_MODES: readonly ModeId[] = ['chat', 'search', 'math', 'draw'];

export function isReady(mode: ModeId): boolean {
  return READY_MODES.includes(mode);
}

export function modeName(mode: ModeId): string {
  return MODES.find((m) => m.id === mode)?.name ?? '';
}
