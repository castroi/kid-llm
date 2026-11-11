import type { AiErrorReason } from '../ai/providers';

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
    default:
      return 'הבקשה לא הושלמה.';
  }
}

/** "דקה", "5 דקות", "30 שניות": how long the parent area stays locked. */
export function waitText(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} שניות`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? 'דקה' : `${minutes} דקות`;
}
