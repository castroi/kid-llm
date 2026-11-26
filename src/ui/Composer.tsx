import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { AttachmentError, limitFor, MAX_DOCUMENTS, type Attachment, type AttachmentProblem, type LimitProblem } from '../core/attachment';
import { MAX_MESSAGE_CHARS } from '../core/chat';
import { NO_MORE_FILES_MESSAGE, PREPARING_FILES_MESSAGE, pickMessage } from '../core/kidMessages';
import { modeName, type ModeId } from '../core/modes';
import { BlobImage } from './BlobImage';
import { fileLabel, FileName } from './FileName';
import { AttachIcon, ChevronDownIcon, CloseIcon, FileIcon, ModeIcon, SendIcon, StopIcon } from './icons';

const MAX_HEIGHT_PX = 140;

/** What the phone's picker offers: pictures, PDF and Word. What a picked file really is gets checked from its bytes. */
const PICKABLE = 'image/*,application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx';

/** A file in the message box: being made ready, or ready to go. Its id stays with it, so a file she took off doesn't come back when it is ready. */
type Item = { id: number; attachment: null } | { id: number; attachment: Attachment };

/** What a picked file probably is, by what the phone says of it: only to skip making ready a file that could not fit anyway. */
const looksLikeDocument = (file: File) => file.type === 'application/pdf' || /\.(pdf|docx)$/i.test(file.name);

export interface ComposerProps {
  mode: ModeId;
  /** The model behind the mode, shown next to the mode's name; empty when the mode has none. */
  model: string;
  writing: boolean;
  /** She can type, but can't send (the chat isn't set up yet). */
  blocked: boolean;
  /**
   * Makes a picked file ready to attach, a picture smaller when `smaller` (the message has more
   * than one); rejects with an AttachmentError. null when she can't attach here (no model for
   * files, or a mode that takes none): no button is shown.
   */
  attach: ((file: File, smaller: boolean) => Promise<Attachment>) | null;
  /** How many pictures one message can carry (src/storage/settings.ts `pictureLimitFor`). */
  pictureLimit?: number;
  /** True when the message was taken; the box is cleared then. */
  onSend: (text: string, attachments: Attachment[]) => boolean;
  onStop: () => void;
  onPickMode: () => void;
  /** Told whether she has started a message: text in the box, or a file picked or being made ready. */
  onDraftChange?: (started: boolean) => void;
}

/** Where she writes. Enter makes a new line, as on any phone keyboard; the button sends. */
export function Composer({ mode, model, writing, blocked, attach, pictureLimit = 1, onSend, onStop, onPickMode, onDraftChange }: ComposerProps) {
  const [text, setText] = useState('');
  const [items, setItems] = useState<readonly Item[]>([]);
  const [problem, setProblem] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const attachButton = useRef<HTMLButtonElement>(null);
  const chips = useRef<HTMLUListElement>(null);
  // The files as they are now, for the work that makes picked files ready one after another.
  const current = useRef<readonly Item[]>([]);
  const nextId = useRef(0);
  // After she takes a file off, focus goes to the next file's remove button, or to the attach button.
  const focusAfterRemove = useRef<number | 'attach' | null>(null);

  const update = (change: (items: readonly Item[]) => readonly Item[]) => {
    current.current = change(current.current);
    setItems(current.current);
  };
  // Files picked where files can go don't follow her into a mode where they can't.
  const shown = attach ? items : [];
  const ready = shown.flatMap((item) => (item.attachment ? [item.attachment] : []));
  const preparing = shown.some((item) => item.attachment === null);
  const pictures = ready.filter((a) => a.kind === 'image').length;
  const full = pictures >= pictureLimit && ready.length - pictures >= MAX_DOCUMENTS;

  const started = text.trim() !== '' || shown.length > 0;
  useEffect(() => {
    onDraftChange?.(started);
  }, [started, onDraftChange]);

  // Grows with the text up to a few lines, then scrolls inside.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  useEffect(() => {
    const target = focusAfterRemove.current;
    if (target === null) return;
    focusAfterRemove.current = null;
    const next = target === 'attach' ? null : chips.current?.querySelector<HTMLElement>(`[data-remove="${target}"]`);
    (next ?? attachButton.current)?.focus();
  }, [items]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (preparing) return;
    if (onSend(text, ready)) {
      setText('');
      update(() => []);
      setProblem('');
    }
  };

  const remove = (id: number) => {
    const at = current.current.findIndex((item) => item.id === id);
    const rest = current.current.filter((item) => item.id !== id);
    focusAfterRemove.current = rest[Math.min(at, rest.length - 1)]?.id ?? 'attach';
    update(() => rest);
    setProblem('');
  };

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // Emptied, so picking the same file again is noticed.
    event.target.value = '';
    if (files.length === 0 || !attach) return;
    setProblem('');
    const readyNow = () => current.current.flatMap((item) => (item.attachment ? [item.attachment] : []));
    // More than one picture in the message: each is redrawn smaller, so the message stays light.
    const picturesSoon = readyNow().filter((a) => a.kind === 'image').length + files.filter((file) => !looksLikeDocument(file)).length;
    const smaller = picturesSoon > 1;
    const ids = files.map(() => ++nextId.current);
    // Every picked file shows at once, waiting; they are made ready one at a time, so a few large photos don't use up the phone's memory.
    update((before) => [...before, ...ids.map((id) => ({ id, attachment: null }))]);
    const limits: LimitProblem[] = [];
    const failed: AttachmentProblem[] = [];
    let added = 0;
    const taken = (id: number) => current.current.some((item) => item.id === id);
    for (const [index, file] of files.entries()) {
      const id = ids[index];
      // She took it off while it waited.
      if (!taken(id)) continue;
      // Already full for its kind: not even opened.
      const attached = readyNow();
      const documents = attached.filter((a) => a.kind !== 'image').length;
      const noRoom = looksLikeDocument(file) ? documents >= MAX_DOCUMENTS : attached.length - documents >= pictureLimit;
      let attachment: Attachment | null = null;
      if (noRoom) limits.push(looksLikeDocument(file) ? 'documents' : 'pictures');
      else {
        try {
          attachment = await attach(file, smaller);
        } catch (err) {
          // One friendly line; the file's name and what went wrong inside it are never shown or kept.
          failed.push(err instanceof AttachmentError ? err.problem : 'unreadable');
        }
      }
      if (!taken(id)) continue;
      const over = attachment ? limitFor(readyNow(), attachment, pictureLimit) : null;
      if (over) limits.push(over);
      if (attachment && !over) {
        const done = attachment;
        update((before) => before.map((item) => (item.id === id ? { id, attachment: done } : item)));
        added += 1;
      } else update((before) => before.filter((item) => item.id !== id));
    }
    setProblem(pickMessage({ picked: files.length, added, limits, failed, pictureLimit }));
  };

  const openPicker = () => {
    if (full) return setProblem(NO_MORE_FILES_MESSAGE);
    picker.current?.click();
  };

  return (
    <form className="composer" onSubmit={submit}>
      {shown.length > 0 && (
        <ul ref={chips} className="attachment-chips" aria-label="הקבצים שצירפתי">
          {shown.map((item, index) => {
            const number = index + 1;
            const { attachment } = item;
            return (
              <li key={item.id} className={attachment?.kind === 'image' ? 'attachment-chip picture' : 'attachment-chip'}>
                <span className="attachment-number" aria-hidden="true">
                  {number}
                </span>
                {attachment === null ? (
                  <span className="attachment-waiting">
                    <span className="spinner" aria-hidden="true" />
                    <span className="visually-hidden">קובץ {number}: מכינה</span>
                  </span>
                ) : attachment.kind === 'image' ? (
                  <>
                    <BlobImage bytes={attachment.bytes} type="image/jpeg" className="attachment-thumb" alt="" />
                    <span className="visually-hidden">{fileLabel(attachment, number)}</span>
                  </>
                ) : (
                  <>
                    <FileIcon />
                    <span className="visually-hidden">קובץ {number}: </span>
                    <FileName attachment={attachment} />
                  </>
                )}
                <button type="button" className="icon-button" aria-label={`הסרת קובץ ${number}`} data-remove={item.id} onClick={() => remove(item.id)}>
                  <CloseIcon />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <label htmlFor="message" className="visually-hidden">
        הודעה
      </label>
      <textarea
        id="message"
        ref={box}
        className="composer-input"
        rows={1}
        dir="auto"
        maxLength={MAX_MESSAGE_CHARS}
        placeholder={shown.length > 1 ? 'מה לעשות עם הקבצים?' : shown.length === 1 ? 'מה לעשות עם הקובץ?' : 'מה רצית לשאול?'}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {attach && (
        <p className="composer-status" role="status">
          {preparing ? PREPARING_FILES_MESSAGE : problem}
        </p>
      )}
      <div className="composer-row">
        <div className="composer-tools">
          <button type="button" className="mode-chip" onClick={onPickMode} aria-haspopup="dialog">
            <ModeIcon mode={mode} size={20} />
            <span>{modeName(mode)}</span>
            <ChevronDownIcon />
          </button>
          {attach && (
            <>
              {/* At the limit it still answers a tap, with the reason: a button that does nothing can't say why. */}
              <button ref={attachButton} type="button" className="icon-button" aria-label="צירוף קובץ" aria-disabled={full || undefined} disabled={preparing || writing} onClick={openPicker}>
                <AttachIcon />
              </button>
              {/* The phone's own picker (photos, camera, files) opens from the button; this input is never seen. */}
              <input ref={picker} className="visually-hidden" type="file" multiple accept={PICKABLE} tabIndex={-1} aria-label="קובץ לצירוף" onChange={(event) => void pick(event)} />
            </>
          )}
          {/* Outside the mode button, so the button is still named by its mode alone. */}
          {model && (
            <bdi dir="ltr" className="composer-model">
              {model}
            </bdi>
          )}
        </div>
        {writing ? (
          <button type="button" className="round-button stop" aria-label="עצירה" onClick={onStop}>
            <StopIcon />
          </button>
        ) : (
          <button type="submit" className="round-button" aria-label="שליחה" disabled={blocked || preparing || text.trim() === ''}>
            <SendIcon />
          </button>
        )}
      </div>
    </form>
  );
}
