/**
 * Turns an answer's text into blocks the screen can show safely: no HTML from the model
 * is ever used, only these few kinds. Maths, numbers with a sign or a unit, links and
 * code are marked left-to-right, because inside Hebrew text "3 + 5 = 8" would otherwise
 * be shown in the opposite order.
 */
export interface Inline {
  kind: 'text' | 'bold' | 'code' | 'ltr';
  text: string;
}

export type Block = { kind: 'code'; text: string } | { kind: 'line'; parts: Inline[]; heading: boolean };

/** A number, a number with a letter ("2x"), or a single letter standing for one ("x"). */
const NUMBER = String.raw`[-+]?(?:[\d(][\d.,()]*[a-zA-Z]?|[a-zA-Z](?![a-zA-Z]))`;
/** "3/4 + 1/8 = 7/8", "7 ÷ 8 = 0.875", "11/11/2026". */
const EXPRESSION = String.raw`${NUMBER}(?:\s*[-+*/÷×=<>^]\s*${NUMBER})+%?`;
/** "-5", "+3", "50%", "12 km", "30°", "23 °F". */
const SIGNED_OR_UNIT = String.raw`[-+]\d[\d.,]*%?|\d[\d.,]*\s?(?:%|°[a-zA-Z]?|[a-zA-Z]+\b)`;
const INLINE = new RegExp(String.raw`\x60([^\x60\n]+)\x60|\*\*([^*\n]+)\*\*|(https?:\/\/\S+)|(${EXPRESSION}|${SIGNED_OR_UNIT})`, 'g');

/** One line's text, split into plain text, bold, code and left-to-right runs. */
export function parseInline(line: string): Inline[] {
  const parts: Inline[] = [];
  const push = (kind: Inline['kind'], text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (kind === 'text' && last?.kind === 'text') last.text += text;
    else parts.push({ kind, text });
  };
  let from = 0;
  for (const match of line.matchAll(INLINE)) {
    const [whole, code, bold, link, maths] = match;
    push('text', line.slice(from, match.index));
    from = match.index + whole.length;
    if (code !== undefined) push('code', code);
    else if (bold !== undefined) push('bold', bold);
    // Part of a word ("src=x"), not maths. Checked here and not with a look-behind in the
    // pattern, which older iPhones (before iOS 16.4) can't read at all.
    else if (maths !== undefined && /[a-zA-Z\d]/.test(line[match.index - 1] ?? '')) push('text', whole);
    else {
      // A sentence's own full stop or comma stays with the sentence, not with the number or link.
      const run = link ?? maths;
      const end = run.replace(/[.,]+$/, '');
      push('ltr', end);
      push('text', run.slice(end.length));
    }
  }
  push('text', line.slice(from));
  return parts;
}

/** The whole answer as blocks: code blocks (between ``` lines) and lines of text. */
export function parseAnswer(text: string): Block[] {
  const blocks: Block[] = [];
  let code: string[] | null = null;
  for (const raw of text.split('\n')) {
    if (raw.trim().startsWith('```')) {
      if (code) {
        blocks.push({ kind: 'code', text: code.join('\n') });
        code = null;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(raw);
      continue;
    }
    let line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+/.test(line);
    if (heading) line = line.replace(/^#{1,6}\s+/, '');
    // A list item keeps its place with a bullet the reader knows.
    line = line.replace(/^[-*]\s+/, '• ');
    blocks.push({ kind: 'line', parts: parseInline(line), heading });
  }
  // Still being written: a code block whose closing line hasn't arrived yet.
  if (code) blocks.push({ kind: 'code', text: code.join('\n') });
  return blocks;
}

/** The answer as plain text for "העתקה": without the markdown signs. */
export function plainText(text: string): string {
  return parseAnswer(text)
    .map((block) => (block.kind === 'code' ? block.text : block.parts.map((part) => part.text).join('')))
    .join('\n');
}
