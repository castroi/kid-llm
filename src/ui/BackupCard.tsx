import { useRef, useState, type ChangeEvent } from 'react';
import type { ParentServices } from '../app/parentServices';
import { BackupError } from '../core/backup';
import { chatsText, importText, sizeText } from '../core/parentMessages';
import type { Backup, HandOver } from '../storage/backup';

const HANDED: Record<HandOver, string> = {
  shared: 'הקובץ נמסר. כדאי לוודא שהוא נשמר במקום פרטי.',
  downloaded: 'הקובץ ירד למכשיר. כדאי לשמור אותו במקום פרטי.',
  cancelled: 'השמירה בוטלה. הקובץ עדיין מוכן.',
  failed: 'חלון השיתוף לא נפתח. כדאי לנסות שוב.',
};

/**
 * Backup, in the parent area: every chat into one file, and a file's chats back onto the phone.
 * Making the file and handing it over are two taps: Safari opens the share sheet only
 * straight from a tap, and reading the chats first would take too long for that.
 */
export function BackupCard({ parent }: { parent: ParentServices }) {
  const [backup, setBackup] = useState<Backup | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const picker = useRef<HTMLInputElement>(null);

  const make = async () => {
    setBusy(true);
    setBackup(null);
    setStatus('מכין את הקובץ...');
    try {
      const made = await parent.makeBackup();
      if (made.chats === 0) setStatus('אין שיחות באייפון, אז אין מה לגבות.');
      else {
        setBackup(made);
        setStatus('');
      }
    } catch {
      setStatus('הכנת הגיבוי לא הצליחה. כדאי לנסות שוב.');
    }
    setBusy(false);
  };

  const hand = async (made: Backup) => {
    const how = await parent.saveBackup(made).catch(() => 'failed' as const);
    setStatus(HANDED[how]);
    // Handed over: the file is let go, so it doesn't stay in memory while the area is open.
    if (how === 'shared' || how === 'downloaded') setBackup(null);
  };

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // The same file can be picked again later.
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setStatus('מייבא...');
    try {
      setStatus(importText(await parent.importBackup(file)));
    } catch (err) {
      setStatus(err instanceof BackupError ? 'זה לא קובץ גיבוי של האפליקציה. שום דבר לא יובא.' : 'הייבוא לא הצליח. שום דבר לא יובא.');
    }
    setBusy(false);
  };

  return (
    <section className="card">
      <h2 className="card-title">גיבוי השיחות</h2>
      <p className="hint">
        הגיבוי הוא קובץ אחד עם כל השיחות שבאייפון, שלה ושל מצב הורים, כולל התמונות, הקבצים ושמות הקבצים שבהן. מפתח ה-API, קוד ההורים וההגדרות אף פעם לא נמצאים בו. הקובץ לא מוצפן: מי שמקבל אותו יכול לקרוא את השיחות, ולכן כדאי לשמור אותו במקום פרטי.
      </p>
      <button type="button" className="button" disabled={busy} onClick={() => void make()}>
        הכנת קובץ גיבוי
      </button>
      {backup && (
        <>
          <p className="hint">
            הקובץ מוכן: {chatsText(backup.chats)}, <bdi dir="ltr">{sizeText(backup.file.size)}</bdi>.
          </p>
          <button type="button" className="button primary" onClick={() => void hand(backup)}>
            שמירת הקובץ
          </button>
        </>
      )}
      <p className="hint">ייבוא מוסיף לאייפון את השיחות שבקובץ. שיחה שכבר נמצאת באייפון לא משתנה, ושום דבר לא נמחק. האפליקציה לא יכולה לדעת אם מישהו שינה את הקובץ: מי שיכול לשנות אותו יכול להכניס לרשימת השיחות שלה כל טקסט וכל תמונה, בלי הנחיות הבטיחות ובלי בדיקת התמונות של הספק. לכן כדאי לייבא רק קובץ שהאפליקציה הזאת הכינה ושנשמר במקום שרק הורה יכול לשנות.</p>
      <button type="button" className="button" disabled={busy} onClick={() => picker.current?.click()}>
        ייבוא מקובץ גיבוי
      </button>
      {/* The phone's own file picker opens from the button; this input is never seen, and is hidden from VoiceOver too (the button is what is used). Any file can be picked: what it is comes from its first bytes. */}
      <input ref={picker} className="visually-hidden" type="file" tabIndex={-1} aria-hidden="true" aria-label="קובץ גיבוי לייבוא" onChange={(event) => void pick(event)} />
      <p className="status" role="status">
        {status}
      </p>
    </section>
  );
}
