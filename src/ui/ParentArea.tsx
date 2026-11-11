import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AI_PROVIDERS, type AiProviderId } from '../ai/catalog';
import { AiError } from '../ai/providers';
import type { ParentServices } from '../app/parentServices';
import { isReady, MODES } from '../core/modes';
import { parentMessage, waitText } from '../core/parentMessages';
import { PIN_PATTERN, type PinResult } from '../storage/pin';
import { MAX_DAILY_LIMIT, MAX_MODEL_CHARS, MAX_NAME_CHARS, MAX_SYSTEM_PROMPT_CHARS, type Settings } from '../storage/settings';

export interface ParentAreaProps {
  parent: ParentServices;
  onClose: () => void;
  /** Every chat was removed from the phone; the chat on the screen has to go too. */
  onChatsDeleted: () => void;
}

/** With no touch for this long the area closes, so a phone left open on it doesn't stay open. */
export const IDLE_CLOSE_MS = 3 * 60_000;

/**
 * The parent's settings, behind the parent's code. The first visit asks to choose a code.
 * It closes by itself when the app goes to the background and after a few minutes with no
 * touch, so a phone handed back to her is not left open on this screen.
 */
export function ParentArea({ parent, onClose, onChatsDeleted }: ParentAreaProps) {
  const [phase, setPhase] = useState<'choose' | 'enter' | 'open'>(() => (parent.hasPin() ? 'enter' : 'choose'));
  // No code on the phone, yet a key or settings are: the code's record was lost or removed.
  // Choosing a new code then starts from nothing, so it can't be a way around the old one.
  const [leftover] = useState(() => !parent.hasPin() && parent.hasSetup());
  const chooseFirstCode = async (pin: string) => {
    if (leftover && !parent.forgetSetup()) return false;
    return parent.setPin(pin);
  };

  const idle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const touched = () => {
    clearTimeout(idle.current);
    idle.current = setTimeout(onClose, IDLE_CLOSE_MS);
  };
  useEffect(() => {
    idle.current = setTimeout(onClose, IDLE_CLOSE_MS);
    return () => clearTimeout(idle.current);
  }, [onClose]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') onClose();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [onClose]);

  return (
    <div className="parent" onPointerDown={touched} onKeyDown={touched} onInput={touched}>
      <header className="top-bar">
        <span className="top-bar-side" />
        <h1 className="top-bar-title">אזור הורים</h1>
        <button type="button" className="text-button" onClick={onClose}>
          סיום
        </button>
      </header>
      <main className="scroll parent-body">
        {phase === 'choose' && (
          <section className="card">
            <h2 className="card-title">בחירת קוד הורים</h2>
            <p className="hint">הקוד שומר על ההגדרות מפני הילדה. אם הוא נשכח, צריך למחוק את נתוני האתר בספארי ולהגדיר הכול מחדש.</p>
            {leftover && <p className="hint">לא נמצא קוד הורים באייפון הזה. בחירת קוד חדש תמחק את המפתח ואת ההגדרות השמורים.</p>}
            <ChooseCode submitLabel="שמירת הקוד" onChosen={chooseFirstCode} onDone={() => setPhase('open')} />
          </section>
        )}
        {phase === 'enter' && <EnterCode parent={parent} onRight={() => setPhase('open')} />}
        {phase === 'open' && <SettingsForm parent={parent} onChatsDeleted={onChatsDeleted} onLocked={onClose} />}
      </main>
    </div>
  );
}

/**
 * Digits only, shown as dots. A plain text field made to look like a password field (the
 * `secret` class): Safari offers to save real password fields in iCloud Keychain whatever
 * the page asks, and a saved code would be offered to her on the same phone.
 */
function CodeField({ id, label, value, onChange, autoFocus }: { id: string; label: string; value: string; onChange: (value: string) => void; autoFocus?: boolean }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input secret"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        maxLength={8}
        dir="ltr"
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, ''))}
      />
    </div>
  );
}

interface ChooseCodeProps {
  submitLabel: string;
  /** Changing an existing code: the current one is asked for and checked first. */
  checkCurrent?: (pin: string) => Promise<PinResult>;
  /** Too many wrong current codes: the area is locked now. */
  onLocked?: () => void;
  onChosen: (pin: string) => Promise<boolean>;
  onDone: () => void;
}

function ChooseCode({ submitLabel, checkCurrent, onLocked, onChosen, onDone }: ChooseCodeProps) {
  const [current, setCurrent] = useState('');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!PIN_PATTERN.test(first)) return setProblem('הקוד צריך להיות 4 עד 8 ספרות.');
    if (first !== second) return setProblem('שני הקודים לא זהים.');
    // An empty current code is not a try: it is not checked and not counted.
    if (checkCurrent && !current) return setProblem('צריך להזין את הקוד הנוכחי.');
    setSaving(true);
    if (checkCurrent) {
      const result = await checkCurrent(current).catch(() => 'wrong' as const);
      if (result !== 'ok') {
        setSaving(false);
        setCurrent('');
        // Locked: whoever is here doesn't know the code, so the open area closes at once.
        if (result === 'locked') return onLocked?.();
        return setProblem('הקוד הנוכחי שגוי.');
      }
    }
    const saved = await onChosen(first).catch(() => false);
    setSaving(false);
    if (saved) onDone();
    else setProblem('הקוד לא נשמר. כדאי לנסות שוב.');
  };

  return (
    <form className="form" onSubmit={(event) => void submit(event)}>
      {checkCurrent && <CodeField id="current-code" label="הקוד הנוכחי" value={current} onChange={setCurrent} autoFocus />}
      <CodeField id="new-code" label="קוד חדש (4 עד 8 ספרות)" value={first} onChange={setFirst} autoFocus={!checkCurrent} />
      <CodeField id="new-code-again" label="שוב, לאימות" value={second} onChange={setSecond} />
      <p className="status" role="status">
        {problem}
      </p>
      <button type="submit" className="button primary" disabled={saving}>
        {submitLabel}
      </button>
    </form>
  );
}

function EnterCode({ parent, onRight }: { parent: ParentServices; onRight: () => void }) {
  const lockedText = () => `יותר מדי ניסיונות. אפשר לנסות שוב בעוד ${waitText(parent.lockedFor())}.`;
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState(() => (parent.lockedFor() > 0 ? lockedText() : ''));
  const [checking, setChecking] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code) return;
    setChecking(true);
    const result = await parent.checkPin(code).catch(() => 'wrong' as const);
    setChecking(false);
    setCode('');
    if (result === 'ok') onRight();
    else setProblem(result === 'locked' ? lockedText() : 'קוד שגוי.');
  };

  return (
    <section className="card">
      <h2 className="card-title">כניסה להגדרות</h2>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <CodeField id="code" label="קוד הורים" value={code} onChange={setCode} autoFocus />
        <p className="status" role="status">
          {problem}
        </p>
        <button type="submit" className="button primary" disabled={checking}>
          כניסה
        </button>
      </form>
    </section>
  );
}

type Check = { state: 'idle' } | { state: 'checking' } | { state: 'ok'; note: string | null } | { state: 'failed'; text: string; detail: string };

function SettingsForm({ parent, onChatsDeleted, onLocked }: { parent: ParentServices; onChatsDeleted: () => void; onLocked: () => void }) {
  const [draft, setDraft] = useState<Settings>(() => parent.loadSettings());
  const [limitText, setLimitText] = useState(() => (draft.dailyLimit === null ? '' : String(draft.dailyLimit)));
  // The saved key is never read back: only whether there is one. What is typed here replaces it on save.
  const [keyText, setKeyText] = useState('');
  const [keySaved, setKeySaved] = useState(() => parent.hasApiKey(draft.provider));
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const [saveStatus, setSaveStatus] = useState('');
  const [sent, setSent] = useState(() => parent.sentToday());
  const [dataStatus, setDataStatus] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [changingCode, setChangingCode] = useState(false);

  const provider: AiProviderId = draft.provider;
  const change = (patch: Partial<Settings>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setSaveStatus('');
  };

  const checkKey = async () => {
    if (!keyText.trim() && !keySaved) return setCheck({ state: 'failed', text: 'צריך להזין מפתח קודם.', detail: '' });
    setCheck({ state: 'checking' });
    try {
      setCheck({ state: 'ok', note: await parent.checkConnection(provider, keyText) });
    } catch (err) {
      // The provider's own message is shown here only; it is never saved anywhere.
      const failed = err instanceof AiError ? err : new AiError('bad-response');
      setCheck({ state: 'failed', text: parentMessage(failed.reason), detail: failed.detail });
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const typedLimit = limitText.trim();
    const limit = typedLimit === '' ? null : Number(typedLimit);
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > MAX_DAILY_LIMIT)) {
      return setSaveStatus(`מספר ההודעות ביום צריך להיות בין 1 ל-${MAX_DAILY_LIMIT}, או ריק ללא הגבלה.`);
    }
    const savedSettings = parent.saveSettings({ ...draft, dailyLimit: limit });
    const savedKey = keyText.trim() ? parent.saveApiKey(provider, keyText) : true;
    if (savedKey) setKeyText('');
    setKeySaved(parent.hasApiKey(provider));
    setSaveStatus(savedSettings && savedKey ? 'נשמר.' : 'לא נשמר. ייתכן שהאחסון בדפדפן חסום או מלא.');
  };

  const removeKey = () => {
    parent.saveApiKey(provider, '');
    setKeyText('');
    setKeySaved(parent.hasApiKey(provider));
    setCheck({ state: 'idle' });
  };

  const deleteAll = async () => {
    setConfirmingDelete(false);
    try {
      await parent.deleteAllChats();
      onChatsDeleted();
      setDataStatus('כל השיחות נמחקו מהאייפון.');
    } catch {
      setDataStatus('המחיקה לא הצליחה. כדאי לנסות שוב.');
    }
  };

  return (
    <>
      <form className="form" onSubmit={save}>
        <section className="card">
          <h2 className="card-title">חיבור</h2>
          <div className="field">
            <label htmlFor="provider">ספק AI</label>
            <select
              id="provider"
              className="input"
              value={provider}
              onChange={(event) => {
                const next = event.target.value as AiProviderId;
                change({ provider: next });
                setKeyText('');
                setKeySaved(parent.hasApiKey(next));
                setCheck({ state: 'idle' });
              }}
            >
              {Object.entries(AI_PROVIDERS).map(([id, info]) => (
                <option key={id} value={id}>
                  {info.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="api-key">מפתח API</label>
            <input
              id="api-key"
              className="input secret"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              dir="ltr"
              placeholder={keySaved ? 'מפתח שמור. הקלדה תחליף אותו' : ''}
              value={keyText}
              onChange={(event) => {
                setKeyText(event.target.value);
                setSaveStatus('');
              }}
            />
            <p className="hint">המפתח נשמר רק באייפון הזה, ואי אפשר להציג אותו שוב. כדאי להגדיר אצל הספק מגבלת הוצאה.</p>
          </div>
          <div className="button-row">
            <button type="button" className="button" disabled={check.state === 'checking'} onClick={() => void checkKey()}>
              בדיקת חיבור
            </button>
            {keySaved && (
              <button type="button" className="button" onClick={removeKey}>
                מחיקת המפתח
              </button>
            )}
          </div>
          <div className="status" role="status">
            {check.state === 'checking' && <p>בודק...</p>}
            {check.state === 'ok' && <p>החיבור תקין.{check.note ? ` ${check.note}` : ''}</p>}
            {check.state === 'failed' && (
              <>
                <p>{check.text}</p>
                {check.detail && (
                  <p className="detail" dir="auto">
                    {check.detail}
                  </p>
                )}
              </>
            )}
          </div>
        </section>

        <section className="card">
          <h2 className="card-title">איזה מודל מאחורי כל מצב</h2>
          {MODES.filter((m) => isReady(m.id)).map((m) => (
            <div className="field" key={m.id}>
              <label htmlFor={`model-${m.id}`}>מודל למצב "{m.name}"</label>
              <input
                id={`model-${m.id}`}
                className="input"
                type="text"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                dir="ltr"
                maxLength={MAX_MODEL_CHARS}
                value={draft.models[m.id]}
                onChange={(event) => change({ models: { ...draft.models, [m.id]: event.target.value } })}
              />
            </div>
          ))}
          <p className="hint">שם המודל כפי שהוא מופיע אצל הספק. הילדה רואה רק את שם המצב. כדאי לבחור רק מודלים עם סינון תוכן.</p>
          <p className="hint">במצב "חיפוש" השאלה שלה נשלחת, דרך הספק, גם למנוע חיפוש. מצב בלי שם מודל לא יהיה זמין לה.</p>
        </section>

        <section className="card">
          <h2 className="card-title">הנחיות והגבלות</h2>
          <div className="field">
            <label htmlFor="system-prompt">הנחיות מערכת (System prompt)</label>
            <textarea
              id="system-prompt"
              className="input"
              rows={5}
              dir="auto"
              maxLength={MAX_SYSTEM_PROMPT_CHARS}
              value={draft.systemPrompt}
              onChange={(event) => change({ systemPrompt: event.target.value })}
            />
            <p className="hint">נשלחות לספק עם כל הודעה, אחרי הנחיות הבטיחות המובנות. עדיף לא לכתוב כאן פרטים מזהים עליה.</p>
          </div>
          <div className="field">
            <label htmlFor="child-name">שם הילדה</label>
            <input id="child-name" className="input" type="text" autoComplete="off" maxLength={MAX_NAME_CHARS} value={draft.childName} onChange={(event) => change({ childName: event.target.value })} />
            <p className="hint">מוצג רק בברכת הפתיחה. לא נשלח לספק.</p>
          </div>
          <div className="field">
            <label htmlFor="daily-limit">מספר הודעות מרבי ביום</label>
            <input
              id="daily-limit"
              className="input"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              dir="ltr"
              maxLength={4}
              placeholder="ללא הגבלה"
              value={limitText}
              onChange={(event) => {
                setLimitText(event.target.value.replace(/\D/g, ''));
                setSaveStatus('');
              }}
            />
          </div>
        </section>

        <p className="status" role="status">
          {saveStatus}
        </p>
        <button type="submit" className="button primary">
          שמירה
        </button>
      </form>

      <section className="card">
        <h2 className="card-title">נתונים באייפון הזה</h2>
        <p className="hint">נשלחו היום: {sent} הודעות.</p>
        <button
          type="button"
          className="button"
          onClick={() => {
            const done = parent.resetUsage();
            setSent(parent.sentToday());
            setDataStatus(done ? 'הספירה של היום אופסה.' : 'האיפוס לא נשמר.');
          }}
        >
          איפוס הספירה של היום
        </button>
        <button type="button" className="button" onClick={() => setChangingCode((open) => !open)}>
          שינוי קוד הורים
        </button>
        {changingCode && (
          <ChooseCode
            submitLabel="החלפת הקוד"
            checkCurrent={parent.checkPin}
            onLocked={onLocked}
            onChosen={parent.setPin}
            onDone={() => {
              setChangingCode(false);
              setDataStatus('קוד ההורים הוחלף.');
            }}
          />
        )}
        {confirmingDelete ? (
          <div className="confirm">
            <p>למחוק את כל השיחות מהאייפון? אי אפשר לבטל את זה.</p>
            <div className="button-row">
              <button type="button" className="button danger" onClick={() => void deleteAll()}>
                כן, למחוק הכול
              </button>
              <button type="button" className="button" onClick={() => setConfirmingDelete(false)}>
                ביטול
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="button danger" onClick={() => setConfirmingDelete(true)}>
            מחיקת כל השיחות
          </button>
        )}
        <p className="status" role="status">
          {dataStatus}
        </p>
      </section>
    </>
  );
}
