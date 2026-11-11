import { describe, expect, it } from 'vitest';
import { cut } from './text';

describe('cut', () => {
  it('leaves short text alone and cuts long text to the limit', () => {
    expect(cut('שלום', 10)).toBe('שלום');
    expect(cut('abcdef', 3)).toBe('abc');
    expect(cut('', 0)).toBe('');
  });

  it('never leaves half an emoji at the end', () => {
    expect(cut('ab😀cd', 3)).toBe('ab');
    expect(cut('ab😀cd', 4)).toBe('ab😀');
  });
});
