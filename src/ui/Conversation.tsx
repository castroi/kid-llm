import { useEffect, useRef, useState } from 'react';
import { plainText } from '../core/answerText';
import type { GeneratedImage } from '../ai/providers';
import { siteName, type Source } from '../ai/sources';
import type { Attachment } from '../core/attachment';
import type { StoredMessage } from '../core/chat';
import { modeName } from '../core/modes';
import { AnswerText } from './AnswerText';
import { CheckIcon, CopyIcon, FileIcon, RetryIcon } from './icons';

const clock = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' });

function CopyButton({ text, copyText }: { text: string; copyText: (text: string) => Promise<void> }) {
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
      onClick={() => {
        // Clean text, without the markdown signs. A refusal by the browser changes nothing on screen.
        copyText(plainText(text)).then(
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

/** A picture she asked for. Its address lives only while it is on the screen. */
function Picture({ image }: { image: GeneratedImage }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const address = URL.createObjectURL(new Blob([image.bytes], { type: image.type }));
    setUrl(address);
    return () => URL.revokeObjectURL(address);
  }, [image]);
  return (
    <>
      {url && <img className="picture" src={url} alt="התמונה שציירתי" />}
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

function Answer({ message, writing, last, onRetry, copyText }: { message: StoredMessage; writing: boolean; last: boolean; onRetry: () => void; copyText: (text: string) => Promise<void> }) {
  const beingWritten = writing && last;
  return (
    <div className="answer">
      {message.image ? (
        <Picture image={message.image} />
      ) : message.text ? (
        <AnswerText text={message.text} />
      ) : message.mode === 'draw' ? (
        <p className="drawing">מציירת...</p>
      ) : (
        <p className="muted">חושבת...</p>
      )}
      {!beingWritten && message.sources && message.sources.length > 0 && <Sources sources={message.sources} />}
      {beingWritten ? (
        <p className="answer-meta">
          {modeName(message.mode)} · {message.mode === 'draw' ? 'זה לוקח כמה שניות' : 'כותבת עכשיו'}
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
            {modeName(message.mode)} · <bdi dir="ltr">{clock.format(message.at)}</bdi>
            {message.state === 'stopped' && ' · עצרת כאן'}
            {message.state === 'failed' && ' · התשובה נקטעה'}
          </span>
        </div>
      )}
    </div>
  );
}

/** What she attached to a message: a picture is shown; a document is shown by her name for it. */
function Attached({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const picture = attachment.kind === 'image';
  useEffect(() => {
    if (!picture) return;
    // Its address lives only while it is on the screen.
    const address = URL.createObjectURL(new Blob([attachment.bytes], { type: 'image/jpeg' }));
    setUrl(address);
    return () => URL.revokeObjectURL(address);
  }, [attachment, picture]);
  if (picture) return url ? <img className="attached-picture" src={url} alt="התמונה שצירפתי" /> : null;
  return (
    <span className="attached-file">
      <FileIcon />
      <span dir="auto">{attachment.name || 'קובץ'}</span>
    </span>
  );
}

export interface ConversationProps {
  messages: readonly StoredMessage[];
  writing: boolean;
  onRetry: () => void;
  copyText: (text: string) => Promise<void>;
}

export function Conversation({ messages, writing, onRetry, copyText }: ConversationProps) {
  const end = useRef<HTMLDivElement>(null);
  const lastText = messages[messages.length - 1]?.text;
  const lastHasPicture = messages[messages.length - 1]?.image !== undefined;
  // Keeps the newest text in view while an answer is being written, and a picture when it arrives.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, lastText, lastHasPicture]);

  return (
    <div className="conversation">
      {messages.map((message, index) =>
        message.role === 'user' ? (
          <div key={message.id} className="bubble" dir="auto">
            {message.attachment && <Attached attachment={message.attachment} />}
            {message.text}
          </div>
        ) : (
          <Answer key={message.id} message={message} writing={writing} last={index === messages.length - 1} onRetry={onRetry} copyText={copyText} />
        ),
      )}
      <div ref={end} />
    </div>
  );
}
