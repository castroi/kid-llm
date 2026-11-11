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

/**
 * A number, a number with a letter ("2x"), or a single letter standing for one ("x").
 * The repeats are bounded (no real number is longer): an unbounded one makes a long run
 * of digits cost time that grows with its square.
 */
const NUMBER = String.raw`[-+]?(?:[\d(][\d.,()]{0,30}[a-zA-Z]?|[a-zA-Z](?![a-zA-Z]))`;
/** "3/4 + 1/8 = 7/8", "7 ÷ 8 = 0.875", "11/11/2026". */
const EXPRESSION = String.raw`${NUMBER}(?:\s*[-+*/÷×=<>^]\s*${NUMBER})+%?`;
/** "-5", "+3", "50%", "12 km", "30°", "23 °F". */
const SIGNED_OR_UNIT = String.raw`[-+]\d[\d.,]{0,30}%?|\d[\d.,]{0,30}\s?(?:%|°[a-zA-Z]?|[a-zA-Z]{1,12}\b)`;
const INLINE = new RegExp(String.raw`\x60([^\x60\n]+)\x60|\*\*([^*\n]+)\*\*|(https?:\/\/\S+)|(${EXPRESSION}|${SIGNED_OR_UNIT})`, 'g');

/**
 * A line longer than this is shown as plain text: a second guard on the time the patterns
 * above can take, whatever a model sends.
 */
export const MAX_INLINE_CHARS = 2_000;

/** An answer is parsed again with every piece that arrives; lines already seen cost nothing. */
const seen = new Map<string, Inline[]>();
const MAX_SEEN = 2_000;

/** Forgets the remembered lines, so answer text doesn't stay in memory after its chat is left or deleted. */
export function forgetParsed(): void {
  seen.clear();
}

/** One line's text, split into plain text, bold, code and left-to-right runs. */
export function parseInline(line: string): Inline[] {
  if (line.length > MAX_INLINE_CHARS) return [{ kind: 'text', text: line }];
  const known = seen.get(line);
  if (known) return known;
  const parts = splitInline(line);
  if (seen.size >= MAX_SEEN) seen.clear();
  seen.set(line, parts);
  return parts;
}

function splitInline(line: string): Inline[] {
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
      let end = run.length;
      while (end > 0 && (run[end - 1] === '.' || run[end - 1] === ',')) end--;
      push('ltr', run.slice(0, end));
      push('text', run.slice(end));
    }
  }
  push('text', line.slice(from));
  return parts;
}

/**
 * Characters nobody sees that change the order text is shown in, or hide inside it:
 * direction overrides and marks, zero-width characters. A model could use them to make
 * a line read differently from what it says; they are removed before anything is shown or copied.
 * The zero-width joiner (U+200D) stays: it changes no direction, and emoji made of several parts need it.
 */
const HIDDEN = /[\u061C\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/** The whole answer as blocks: code blocks (between ``` lines) and lines of text. */
export function parseAnswer(text: string): Block[] {
  const blocks: Block[] = [];
  let code: string[] | null = null;
  for (const raw of text.replace(HIDDEN, '').split('\n')) {
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
