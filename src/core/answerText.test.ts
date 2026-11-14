import { describe, expect, it } from 'vitest';
import { MAX_INLINE_CHARS, parseAnswer, parseInline, plainText } from './answerText';

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

  it('marks bold and code, and a bare address as a link without the sentence\'s full stop', () => {
    expect(kinds('התשובה היא **7/8**, נכון?')).toEqual(['text:התשובה היא ', 'bold:7/8', 'text:, נכון?']);
    expect(kinds('ראי https://example.com/a?b=1. וגם `print(1)`')).toEqual(['text:ראי ', 'link:https://example.com/a?b=1', 'text:. וגם ', 'code:print(1)']);
  });

  it('reads a markdown link as its label and its address', () => {
    expect(parseInline('לחצי [כאן לחיפוש](https://www.google.com/search?q=x+y) עכשיו')).toEqual([
      { kind: 'text', text: 'לחצי ' },
      { kind: 'link', text: 'כאן לחיפוש', url: 'https://www.google.com/search?q=x+y' },
      { kind: 'text', text: ' עכשיו' },
    ]);
  });

  it('leaves a closing bracket the address did not open with the sentence, and keeps one it did', () => {
    expect(kinds('(ראי https://a.com/x).')).toEqual(['text:(ראי ', 'link:https://a.com/x', 'text:).']);
    expect(kinds('https://en.wikipedia.org/wiki/Cat_(disambiguation)')).toEqual(['link:https://en.wikipedia.org/wiki/Cat_(disambiguation)']);
    expect(kinds('https://')).toEqual(['text:https://']);
  });

  it('gives back text it has nothing to say about, also when it is empty', () => {
    expect(kinds('שלום, מה נשמע?')).toEqual(['text:שלום, מה נשמע?']);
    expect(kinds('')).toEqual([]);
  });

  it('never produces HTML: tags in an answer stay text', () => {
    expect(kinds('<img src=x onerror=alert(1)>')).toEqual(['text:<img src=x onerror=alert(1)>']);
  });

  it('does not take a letter inside a word for maths', () => {
    expect(kinds('src=x and max=5')).toEqual(['text:src=x and max=5']);
    expect(kinds('x = 5')).toEqual(['ltr:x = 5']);
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

describe('a hostile or broken answer', () => {
  it('is parsed quickly however long its runs of digits, brackets or commas are', () => {
    const started = performance.now();
    for (const line of ['1'.repeat(200_000), '('.repeat(200_000), '1.'.repeat(100_000), `http://a${','.repeat(200_000)}`, `${'1'.repeat(MAX_INLINE_CHARS - 1)}x`]) {
      parseAnswer(line);
    }
    // Many lines just under the limit, as a long answer re-parsed while it is written.
    const many = Array.from({ length: 100 }, (_, i) => `${i} ${'9'.repeat(MAX_INLINE_CHARS - 10)}`).join('\n');
    parseAnswer(many);
    parseAnswer(`${many}\nעוד שורה`);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it('shows a line that is too long as plain text', () => {
    const long = `3 + 5 = 8 ${'א'.repeat(MAX_INLINE_CHARS)}`;
    expect(parseInline(long)).toEqual([{ kind: 'text', text: long }]);
  });

  it('removes hidden characters that reverse or hide text, on screen and in what is copied', () => {
    const tricky = 'בטוח\u202Eלא\u202C \u200Bלגמרי\u2066!\u2069\uFEFF';
    expect(parseAnswer(tricky)).toEqual([{ kind: 'line', heading: false, parts: [{ kind: 'text', text: 'בטוחלא לגמרי!' }] }]);
    expect(plainText(tricky)).toBe('בטוחלא לגמרי!');
    // An emoji made of joined parts stays whole.
    expect(plainText('כל הכבוד 👩\u200D🚀')).toBe('כל הכבוד 👩\u200D🚀');
  });
});

describe('plainText', () => {
  it('copies a labelled link with its address', () => {
    expect(plainText('ראי [כאן](https://a.com/x) ו-https://b.com')).toBe('ראי כאן (https://a.com/x) ו-https://b.com');
  });

  it('is the answer without the markdown signs, for copying', () => {
    expect(plainText('**מודגש** ו`קוד`\n```\nx=1\n```\n## כותרת')).toBe('מודגש וקוד\nx=1\nכותרת');
  });
});
