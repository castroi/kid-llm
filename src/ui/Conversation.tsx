import { useEffect, useRef, useState } from 'react';
import { plainText } from '../core/answerText';
import type { GeneratedImage } from '../ai/providers';
import { siteName, type Source } from '../ai/sources';
import type { Attachment } from '../core/attachment';
import type { StoredMessage } from '../core/chat';
import { modeName } from '../core/modes';
import { AnswerText } from './AnswerText';
import { BlobImage } from './BlobImage';
import { fileLabel, FileName } from './FileName';
import { CheckIcon, CloseIcon, CopyIcon, FileIcon, RetryIcon } from './icons';

const clock = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' });

/**
 * Copies an answer (as clean text) or, with `label`, her own message exactly as she wrote it.
 * `label` names the button for a screen reader, so the two kinds can be told apart.
 */
function CopyButton({ text, copyText, label }: { text: string; copyText: (text: string) => Promise<void>; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="small-button"
      aria-label={label === undefined || copied ? undefined : label}
      onClick={() => {
        // An answer is copied as clean text, without the markdown signs; her own words are copied
        // as they are. A refusal by the browser changes nothing on screen.
        copyText(label === undefined ? plainText(text) : text).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span aria-live="polite">{copied ? 'הועתק!' : 'העתקה'}</span>
    </button>
  );
}

/** A picture she asked for. */
function Picture({ image }: { image: GeneratedImage }) {
  return (
    <>
      <BlobImage bytes={image.bytes} type={image.type} className="picture" alt="התמונה שציירתי" />
      <p className="answer-meta">כדי לשמור: לחיצה ארוכה על התמונה</p>
    </>
  );
}

/**
 * Where a search answer came from: links to the sites, each shown by the site's name only
 * (never the page's title, which nobody checked). A link opens outside the app, sends no
 * referrer, and the page it opens gets no handle back to the app.
 */
function Sources({ sources }: { sources: readonly Source[] }) {
  return (
    <div className="sources">
      <p className="answer-meta">מאיפה התשובה:</p>
      <ul className="source-list">
        {sources.map((source) => (
          <li key={source.url}>
            <a className="source-link" href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
              <bdi dir="ltr">{siteName(source.url)}</bdi>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The model that wrote an answer, after the mode's name: a name in Latin letters, so left to right. Nothing for an answer kept before names were. */
function ModelName({ model }: { model?: string }) {
  if (!model) return null;
  return (
    <>
      {' · '}
      <bdi dir="ltr">{model}</bdi>
    </>
  );
}

function Answer({ message, writing, last, onRetry, copyText, links }: { message: StoredMessage; writing: boolean; last: boolean; onRetry: () => void; copyText: (text: string) => Promise<void>; links: boolean }) {
  const beingWritten = writing && last;
  return (
    <div className="answer">
      {message.image ? (
        <Picture image={message.image} />
      ) : message.text ? (
        <AnswerText text={message.text} links={links && !beingWritten} />
      ) : message.mode === 'draw' ? (
        <p className="drawing">מציירת...</p>
      ) : (
        <p className="muted">חושבת...</p>
      )}
      {!beingWritten && message.sources && message.sources.length > 0 && <Sources sources={message.sources} />}
      {beingWritten ? (
        <p className="answer-meta">
          {modeName(message.mode)}
          <ModelName model={message.model} /> · {message.mode === 'draw' ? 'זה לוקח כמה שניות' : 'כותבת עכשיו'}
        </p>
      ) : (
        <div className="answer-actions">
          {!message.image && <CopyButton text={message.text} copyText={copyText} />}
          {last && (
            <button type="button" className="small-button" onClick={onRetry}>
              <RetryIcon />
              <span>נסי שוב</span>
            </button>
          )}
          <span className="answer-meta">
            {modeName(message.mode)}
            <ModelName model={message.model} /> · <bdi dir="ltr">{clock.format(message.at)}</bdi>
            {message.state === 'stopped' && ' · עצרת כאן'}
            {message.state === 'failed' && ' · התשובה נקטעה'}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * A picture she attached, over the whole screen, so she can see it better. Closes with its
 * button, a tap beside it, or Escape; focus goes back to where it was.
 */
function PictureViewer({ attachment, number, onClose }: { attachment: Attachment; number: number; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus();
    return () => before?.focus();
  }, []);
  return (
    <div
      className="sheet-layer viewer-layer"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <button type="button" className="scrim" aria-label="סגירה" tabIndex={-1} onClick={onClose} />
      <div className="viewer" role="dialog" aria-modal="true" aria-label={`תמונה ${number} שצירפתי`}>
        <button ref={close} type="button" className="icon-button viewer-close" aria-label="סגירת התמונה" onClick={onClose}>
          <CloseIcon />
        </button>
        <BlobImage bytes={attachment.bytes} type="image/jpeg" className="viewer-picture" alt={`תמונה ${number} שצירפתי`} />
      </div>
    </div>
  );
}

/**
 * What she attached to a message, numbered from 1 in the order she added the files, as they
 * were sent: pictures in a grid (a tap shows one over the whole screen), documents by her name for them.
 */
function Attached({ attachments }: { attachments: readonly Attachment[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const numbered = attachments.map((attachment, index) => ({ attachment, number: index + 1 }));
  const pictures = numbered.filter(({ attachment }) => attachment.kind === 'image');
  const documents = numbered.filter(({ attachment }) => attachment.kind !== 'image');
  const shown = open === null ? undefined : numbered[open - 1];
  return (
    <>
      {pictures.length > 0 && (
        <ul className={pictures.length > 1 ? 'attached-pictures grid' : 'attached-pictures'}>
          {pictures.map(({ attachment, number }) => (
            <li key={number} className="attached-picture-item">
              <button type="button" className="attached-picture-button" aria-label={`${fileLabel(attachment, number)}: הגדלה`} onClick={() => setOpen(number)}>
                <BlobImage bytes={attachment.bytes} type="image/jpeg" className="attached-picture" alt={`תמונה ${number} שצירפתי`} />
                {attachments.length > 1 && (
                  <span className="attachment-number" aria-hidden="true">
                    {number}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {documents.map(({ attachment, number }) => (
        <span key={number} className="attached-file">
          {attachments.length > 1 && (
            <span className="attachment-number" aria-hidden="true">
              {number}
            </span>
          )}
          <FileIcon />
          <span className="visually-hidden">קובץ {number}: </span>
          <FileName attachment={attachment} />
        </span>
      ))}
      {shown && <PictureViewer attachment={shown.attachment} number={shown.number} onClose={() => setOpen(null)} />}
    </>
  );
}

export interface ConversationProps {
  messages: readonly StoredMessage[];
  writing: boolean;
  onRetry: () => void;
  copyText: (text: string) => Promise<void>;
  /** A parent's own use: web addresses the model wrote can be tapped, once the answer is finished. Never for her. */
  links?: boolean;
}

export function Conversation({ messages, writing, onRetry, copyText, links = false }: ConversationProps) {
  const end = useRef<HTMLDivElement>(null);
  const lastText = messages[messages.length - 1]?.text;
  const lastHasPicture = messages[messages.length - 1]?.image !== undefined;
  // Keeps the newest text in view while an answer is being written, and a picture when it arrives.
  // Only the conversation's own scrolling box moves: scrollIntoView would also scroll the page
  // itself, and on the iPhone that left the top bar pushed up, even on the next screen.
  useEffect(() => {
    const box = end.current?.closest('.scroll');
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages.length, lastText, lastHasPicture]);

  return (
    <div className="conversation">
      {messages.map((message, index) =>
        message.role === 'user' ? (
          <div key={message.id} className="mine">
            <div className="bubble" dir="auto">
              {message.attachments && <Attached attachments={message.attachments} />}
              {message.text}
            </div>
            {/* Only her words are copied; a file she attached never goes to the clipboard. */}
            <CopyButton text={message.text} copyText={copyText} label="העתקה של מה שכתבתי" />
          </div>
        ) : (
          <Answer key={message.id} message={message} writing={writing} last={index === messages.length - 1} onRetry={onRetry} copyText={copyText} links={links} />
        ),
      )}
      <div ref={end} />
    </div>
  );
}
