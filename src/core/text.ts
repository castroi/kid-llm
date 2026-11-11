/**
 * Cuts text to at most `max` characters without splitting an emoji (or any character that
 * takes two units) in half, which would leave a broken sign at the end.
 */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = text.charCodeAt(max - 1);
  // A first half whose second half would fall outside the cut.
  const splits = end >= 0xd800 && end <= 0xdbff;
  return text.slice(0, splits ? max - 1 : max);
}
