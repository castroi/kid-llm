import type { AiErrorReason } from '../ai/providers';
import { MAX_DOCUMENTS, type AttachmentProblem, type LimitProblem } from './attachment';

/**
 * What she is told when a call fails: one friendly line, never the provider's message
 * or an error code, and never her fault. `retry` says whether "ננסה שוב" makes sense.
 */
export function kidMessage(reason: AiErrorReason): { text: string; retry: boolean } {
  switch (reason) {
    case 'network':
      return { text: 'אין אינטרנט כרגע. ננסה שוב?', retry: true };
    case 'timeout':
      return { text: 'זה לקח יותר מדי זמן. ננסה שוב?', retry: true };
    case 'rate-limited':
      return { text: 'צריך לחכות רגע ואז לנסות שוב.', retry: true };
    case 'provider-down':
    case 'bad-response':
      return { text: 'משהו לא עבד הפעם. ננסה שוב?', retry: true };
    case 'refused':
      return { text: 'על זה אני לא יכולה לענות. אפשר לשאול משהו אחר?', retry: false };
    default:
      // The key, the credit or the model name: only a parent can fix these.
      return { text: 'משהו לא עובד. כדאי לקרוא לאבא או לאמא.', retry: false };
  }
}

export const SETUP_MESSAGE = "הצ'אט עוד לא מוכן. צריך שאבא או אמא יגדירו אותו.";
export const LIMIT_MESSAGE = 'סיימנו להיום! נמשיך לדבר מחר.';
export const NOT_SAVED_MESSAGE = 'השיחה הזאת לא נשמרת באייפון.';
/** On the chat screen when a newer version of the app is out; tapping "לעדכן" loads it. */
export const UPDATE_MESSAGE = 'יש גרסה חדשה של האפליקציה.';
/** On the chat screen for as long as a parent has the child instructions switched off, so it isn't left that way unnoticed. */
export const PARENT_USE_MESSAGE = 'מצב הורים: הנחיות הבטיחות לילדים כבויות.';

/** What she is told when a file can't be attached: one friendly line, never the file's name or a technical reason. */
export function attachmentMessage(problem: AttachmentProblem): string {
  switch (problem) {
    case 'unsupported':
      return 'אפשר לצרף רק תמונה או מסמך.';
    case 'too-large':
      return 'הקובץ הזה גדול מדי. אפשר לנסות קובץ קטן יותר.';
    default:
      return 'לא הצלחתי לפתוח את הקובץ הזה. ננסה קובץ אחר?';
  }
}

/** When she taps the attach button and the message already holds all the files it can. */
export const NO_MORE_FILES_MESSAGE = 'אי אפשר לצרף עוד קבצים להודעה הזאת.';
/** While picked files are being made ready; she can send once they are. */
export const PREPARING_FILES_MESSAGE = 'מכינה את הקבצים...';

/** Why a file that opened fine was left out: which limit of the message it hit. */
export function limitMessage(problem: LimitProblem, pictureLimit: number): string {
  switch (problem) {
    case 'pictures':
      return pictureLimit === 1 ? 'אפשר לצרף רק תמונה אחת להודעה.' : `אפשר לצרף עד ${pictureLimit} תמונות להודעה.`;
    case 'documents':
      return `אפשר לצרף עד ${MAX_DOCUMENTS} מסמכים להודעה.`;
    default:
      return 'הקבצים יחד גדולים מדי. אפשר לצרף פחות קבצים.';
  }
}

/** What happened to the files she picked at once, when not all of them were attached. */
export interface PickResult {
  picked: number;
  added: number;
  /** The limits that left files out, once each. */
  limits: readonly LimitProblem[];
  /** Files that could not be made ready, by why. */
  failed: readonly AttachmentProblem[];
  pictureLimit: number;
}

/**
 * One friendly line about the files she picked: empty when all of them were attached. Says how
 * many were attached and why the others were not; never a file's name or a technical reason.
 */
export function pickMessage({ picked, added, limits, failed, pictureLimit }: PickResult): string {
  if (limits.length === 0 && failed.length === 0) return '';
  if (picked === 1 || (limits.length === 0 && failed.length === 1 && added === 0)) {
    return failed.length > 0 ? attachmentMessage(failed[0]) : limitMessage(limits[0], pictureLimit);
  }
  const lines: string[] = [];
  if (added === 1) lines.push(`צירפתי קובץ אחד מתוך ${picked}.`);
  else if (added > 1) lines.push(`צירפתי ${added} מתוך ${picked}.`);
  for (const problem of new Set(limits)) lines.push(limitMessage(problem, pictureLimit));
  if (failed.length === 1) lines.push('קובץ אחד לא נפתח.');
  else if (failed.length > 1) lines.push(`${failed.length} קבצים לא נפתחו.`);
  return lines.join(' ');
}
