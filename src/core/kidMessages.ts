import type { AiErrorReason } from '../ai/providers';

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
