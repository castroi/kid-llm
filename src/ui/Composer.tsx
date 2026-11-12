import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { AttachmentError, type Attachment } from '../core/attachment';
import { MAX_MESSAGE_CHARS } from '../core/chat';
import { attachmentMessage } from '../core/kidMessages';
import { modeName, type ModeId } from '../core/modes';
import { AttachIcon, ChevronDownIcon, CloseIcon, FileIcon, ModeIcon, SendIcon, StopIcon } from './icons';

const MAX_HEIGHT_PX = 140;

/** What the phone's picker offers: pictures, PDF and Word. What a picked file really is gets checked from its bytes. */
const PICKABLE = 'image/*,application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx';

export interface ComposerProps {
  mode: ModeId;
  writing: boolean;
  /** She can type, but can't send (the chat isn't set up yet). */
  blocked: boolean;
  /**
   * Makes a picked file ready to attach; rejects with an AttachmentError. null when she
   * can't attach here (no model for files, or a mode that takes none): no button is shown.
   */
  attach: ((file: File) => Promise<Attachment>) | null;
  /** True when the message was taken; the box is cleared then. */
  onSend: (text: string, attachment?: Attachment) => boolean;
  onStop: () => void;
  onPickMode: () => void;
}

/** Where she writes. Enter makes a new line, as on any phone keyboard; the button sends. */
export function Composer({ mode, writing, blocked, attach, onSend, onStop, onPickMode }: ComposerProps) {
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<Attachment | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [problem, setProblem] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  // A file picked where files can go doesn't follow her into a mode where they can't.
  const attachment = attach ? picked : null;

  // Grows with the text up to a few lines, then scrolls inside.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (preparing) return;
    if (onSend(text, attachment ?? undefined)) {
      setText('');
      setPicked(null);
      setProblem('');
    }
  };

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Emptied, so picking the same file again is noticed.
    event.target.value = '';
    if (!file || !attach) return;
    setProblem('');
    setPreparing(true);
    try {
      setPicked(await attach(file));
    } catch (err) {
      setPicked(null);
      // One friendly line; the file's name and what went wrong inside it are never shown or kept.
      setProblem(attachmentMessage(err instanceof AttachmentError ? err.problem : 'unreadable'));
    } finally {
      setPreparing(false);
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      {attachment && (
        <div className="attachment-chip">
          <FileIcon />
          {/* Her own file name: shown as text, in the direction of the language it is written in. */}
          <span className="attachment-name" dir="auto">
            {attachment.kind === 'image' ? 'תמונה' : attachment.name || 'קובץ'}
          </span>
          <button type="button" className="icon-button" aria-label="הסרת הקובץ" onClick={() => setPicked(null)}>
            <CloseIcon />
          </button>
        </div>
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
        placeholder={attachment ? 'מה לעשות עם הקובץ?' : 'מה רצית לשאול?'}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {attach && (
        <p className="composer-status" role="status">
          {preparing ? 'מכינה את הקובץ...' : problem}
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
              <button type="button" className="icon-button" aria-label="צירוף קובץ" disabled={preparing || writing} onClick={() => picker.current?.click()}>
                <AttachIcon />
              </button>
              {/* The phone's own picker (photos, camera, files) opens from the button; this input is never seen. */}
              <input ref={picker} className="visually-hidden" type="file" accept={PICKABLE} tabIndex={-1} aria-label="קובץ לצירוף" onChange={(event) => void pick(event)} />
            </>
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
