import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MAX_MESSAGE_CHARS } from '../core/chat';
import { modeName, type ModeId } from '../core/modes';
import { ChevronDownIcon, ModeIcon, SendIcon, StopIcon } from './icons';

const MAX_HEIGHT_PX = 140;

export interface ComposerProps {
  mode: ModeId;
  writing: boolean;
  /** She can type, but can't send (the chat isn't set up yet). */
  blocked: boolean;
  /** True when the message was taken; the box is cleared then. */
  onSend: (text: string) => boolean;
  onStop: () => void;
  onPickMode: () => void;
}

/** Where she writes. Enter makes a new line, as on any phone keyboard; the button sends. */
export function Composer({ mode, writing, blocked, onSend, onStop, onPickMode }: ComposerProps) {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  // Grows with the text up to a few lines, then scrolls inside.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (onSend(text)) setText('');
  };

  return (
    <form className="composer" onSubmit={submit}>
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
        placeholder="מה רצית לשאול?"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="composer-row">
        <button type="button" className="mode-chip" onClick={onPickMode} aria-haspopup="dialog">
          <ModeIcon mode={mode} size={20} />
          <span>{modeName(mode)}</span>
          <ChevronDownIcon />
        </button>
        {writing ? (
          <button type="button" className="round-button stop" aria-label="עצירה" onClick={onStop}>
            <StopIcon />
          </button>
        ) : (
          <button type="submit" className="round-button" aria-label="שליחה" disabled={blocked || text.trim() === ''}>
            <SendIcon />
          </button>
        )}
      </div>
    </form>
  );
}
