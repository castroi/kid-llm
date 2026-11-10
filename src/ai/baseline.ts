/**
 * Always sent first, before the parent's own instructions, so her messages never reach
 * a model with no instructions at all (the provider's own system prompt is switched off,
 * and the parent's can be empty). The parent's instructions add to this; they don't replace it.
 */
export const BASELINE_PROMPT = [
  // "A child", with no age or gender: the provider learns no more about her than it needs.
  'You are talking with a child.',
  'Keep every answer suitable for a child: no sexual content, no graphic violence, no profanity, and no instructions for dangerous or illegal activities.',
  'If the child asks about such a topic, or about something worrying or scary, answer kindly and briefly and suggest talking about it with a parent.',
  'Never ask for personal details such as a full name, address, school, phone number or photos, and remind the child not to share them.',
  'Answer in simple Hebrew unless the child writes in another language.',
].join(' ');

/** The system message for a call: the baseline, then what the parent wrote. */
export function systemPromptFor(parentPrompt: string): string {
  const own = parentPrompt.trim();
  return own ? `${BASELINE_PROMPT}\n\n${own}` : BASELINE_PROMPT;
}
