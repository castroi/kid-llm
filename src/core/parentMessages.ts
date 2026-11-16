import type { AiErrorReason } from '../ai/providers';
import type { ImportResult } from './backup';

/** What the parent is told when a call to the provider fails. The provider's own message is shown next to it. */
export function parentMessage(reason: AiErrorReason): string {
  switch (reason) {
    case 'unauthorized':
      return 'המפתח לא התקבל. כדאי לבדוק שהוא הועתק במלואו ושהוא פעיל.';
    case 'no-credit':
      return 'נגמרה היתרה בחשבון אצל הספק.';
    case 'rate-limited':
      return 'יותר מדי בקשות כרגע. אפשר לנסות שוב בעוד רגע.';
    case 'bad-request':
      return 'הספק לא קיבל את הבקשה. כדאי לבדוק את שם המודל.';
    case 'provider-down':
      return 'השירות של הספק לא זמין כרגע.';
    case 'network':
      return 'אין חיבור לספק. כדאי לבדוק את האינטרנט.';
    case 'timeout':
      return 'הספק לא ענה בזמן.';
    case 'bad-response':
      return 'התקבלה תשובה לא צפויה מהספק.';
    case 'not-verified':
      return 'לא הצלחנו לאמת שהמודל רץ בסביבה מוגנת (attestation), ולכן ההודעה לא נשלחה.';
    default:
      return 'הבקשה לא הושלמה.';
  }
}

/** "שיחה אחת", "12 שיחות". */
export function chatsText(count: number): string {
  return count === 1 ? 'שיחה אחת' : `${count} שיחות`;
}

/** "340 KB", "3.4 MB": a file's size, for the parent area. Shown left to right. */
export function sizeText(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** What the parent is told after a backup file was imported. */
export function importText({ added, kept, unreadable, ended }: ImportResult): string {
  const lines = [added === 0 ? 'לא נוספו שיחות.' : added === 1 ? 'נוספה שיחה אחת.' : `נוספו ${added} שיחות.`];
  if (kept > 0) lines.push(kept === 1 ? 'שיחה אחת כבר הייתה באייפון ולא שונתה.' : `${kept} שיחות כבר היו באייפון ולא שונו.`);
  if (unreadable > 0) lines.push(unreadable === 1 ? 'רשומה אחת בקובץ היא לא שיחה, ודילגנו עליה.' : `${unreadable} רשומות בקובץ הן לא שיחות, ודילגנו עליהן.`);
  if (ended === 'cut') lines.push('הקובץ קטוע או פגום: מה שבא בו אחרי הנקודה הזאת לא יובא.');
  if (ended === 'not-saved') lines.push('הייבוא נעצר כי האייפון לא שמר שיחה. ייתכן שהאחסון מלא.');
  return lines.join(' ');
}

/** "דקה", "5 דקות", "30 שניות": how long the parent area stays locked. */
export function waitText(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} שניות`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? 'דקה' : `${minutes} דקות`;
}
