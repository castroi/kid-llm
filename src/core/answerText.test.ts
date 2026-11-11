import { describe, expect, it } from 'vitest';
import { parseAnswer, parseInline, plainText } from './answerText';

const kinds = (line: string) => parseInline(line).map((part) => `${part.kind}:${part.text}`);

describe('parseInline', () => {
  it('keeps maths left to right inside Hebrew text, and leaves the full stop with the sentence', () => {
    expect(kinds('נהפוך את 3/4 לשמיניות: 3/4 = 6/8.')).toEqual(['text:נהפוך את ', 'ltr:3/4', 'text: לשמיניות: ', 'ltr:3/4 = 6/8', 'text:.']);
    expect(kinds('7 ÷ 8 = 0.875')).toEqual(['ltr:7 ÷ 8 = 0.875']);
    expect(kinds('2x + 3 = 7')).toEqual(['ltr:2x + 3 = 7']);
    expect(kinds('x = 5 וגם a + b = c')).toEqual(['ltr:x = 5', 'text: וגם ', 'ltr:a + b = c']);
  });

  it('keeps a number with a sign or a unit together', () => {
    expect(kinds('הטמפרטורה היא -5 מעלות, או 23 °F, מרחק 12 km')).toEqual(['text:הטמפרטורה היא ', 'ltr:-5', 'text: מעלות, או ', 'ltr:23 °F', 'text:, מרחק ', 'ltr:12 km']);
    expect(kinds('כלומר 87.5%.')).toEqual(['text:כלומר ', 'ltr:87.5%', 'text:.']);
  });

  it('leaves plain numbers in a sentence alone', () => {
    expect(kinds('בשנת 2026 היו 3 חתולים')).toEqual(['text:בשנת 2026 היו 3 חתולים']);
  });

  it('marks bold and code, and shows a link as left-to-right text', () => {
    expect(kinds('התשובה היא **7/8**, נכון?')).toEqual(['text:התשובה היא ', 'bold:7/8', 'text:, נכון?']);
    expect(kinds('ראי https://example.com/a?b=1. וגם `print(1)`')).toEqual(['text:ראי ', 'ltr:https://example.com/a?b=1', 'text:. וגם ', 'code:print(1)']);
  });

  it('gives back text it has nothing to say about, also when it is empty', () => {
    expect(kinds('שלום, מה נשמע?')).toEqual(['text:שלום, מה נשמע?']);
    expect(kinds('')).toEqual([]);
  });

  it('never produces HTML: tags in an answer stay text', () => {
    expect(kinds('<img src=x onerror=alert(1)>')).toEqual(['text:<img src=x onerror=alert(1)>']);
  });
});

describe('parseAnswer', () => {
  it('splits an answer into headings, lines, list items and code blocks', () => {
    const blocks = parseAnswer('# כותרת\n\nשורה\n- פריט\n```python\nprint(1)\nx = 2\n```\nסוף');
    expect(blocks).toEqual([
      { kind: 'line', heading: true, parts: [{ kind: 'text', text: 'כותרת' }] },
      { kind: 'line', heading: false, parts: [{ kind: 'text', text: 'שורה' }] },
      { kind: 'line', heading: false, parts: [{ kind: 'text', text: '• פריט' }] },
      { kind: 'code', text: 'print(1)\nx = 2' },
      { kind: 'line', heading: false, parts: [{ kind: 'text', text: 'סוף' }] },
    ]);
  });

  it('shows a code block that is still being written', () => {
    expect(parseAnswer('הנה:\n```\nprint(1)')).toEqual([
      { kind: 'line', heading: false, parts: [{ kind: 'text', text: 'הנה:' }] },
      { kind: 'code', text: 'print(1)' },
    ]);
  });

  it('is empty for an empty answer', () => {
    expect(parseAnswer('')).toEqual([]);
    expect(parseAnswer('  \n \n')).toEqual([]);
  });
});

describe('plainText', () => {
  it('is the answer without the markdown signs, for copying', () => {
    expect(plainText('**מודגש** ו`קוד`\n```\nx=1\n```\n## כותרת')).toBe('מודגש וקוד\nx=1\nכותרת');
  });
});
