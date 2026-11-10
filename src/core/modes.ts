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
