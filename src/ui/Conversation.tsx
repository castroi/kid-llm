import { useEffect, useRef, useState } from 'react';
import { plainText } from '../core/answerText';
import type { StoredMessage } from '../core/chat';
import { modeName } from '../core/modes';
import { AnswerText } from './AnswerText';
import { CheckIcon, CopyIcon, RetryIcon } from './icons';

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

function Answer({ message, writing, last, onRetry, copyText }: { message: StoredMessage; writing: boolean; last: boolean; onRetry: () => void; copyText: (text: string) => Promise<void> }) {
  const beingWritten = writing && last;
  return (
    <div className="answer">
      {message.text ? <AnswerText text={message.text} /> : <p className="muted">חושבת...</p>}
      {beingWritten ? (
        <p className="answer-meta">{modeName(message.mode)} · כותבת עכשיו</p>
      ) : (
        <div className="answer-actions">
          <CopyButton text={message.text} copyText={copyText} />
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

export interface ConversationProps {
  messages: readonly StoredMessage[];
  writing: boolean;
  onRetry: () => void;
  copyText: (text: string) => Promise<void>;
}

export function Conversation({ messages, writing, onRetry, copyText }: ConversationProps) {
  const end = useRef<HTMLDivElement>(null);
  const lastText = messages[messages.length - 1]?.text;
  // Keeps the newest text in view while an answer is being written.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, lastText]);

  return (
    <div className="conversation">
      {messages.map((message, index) =>
        message.role === 'user' ? (
          <div key={message.id} className="bubble" dir="auto">
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
