import { parseAnswer, type Inline } from '../core/answerText';

function Part({ part }: { part: Inline }) {
  switch (part.kind) {
    case 'bold':
      return <strong>{part.text}</strong>;
    case 'code':
      return (
        <code dir="ltr" className="inline-code">
          {part.text}
        </code>
      );
    case 'ltr':
      // Maths, numbers with a unit and links keep their own order inside Hebrew text.
      return <bdi dir="ltr">{part.text}</bdi>;
    default:
      return <>{part.text}</>;
  }
}

/**
 * An answer on the screen. The model's text is shown as text only (React escapes it);
 * nothing in it can become HTML or a link she could tap.
 */
export function AnswerText({ text }: { text: string }) {
  return (
    <div className="answer-text">
      {parseAnswer(text).map((block, index) =>
        block.kind === 'code' ? (
          <pre key={index} dir="ltr" className="code-block">
            <code>{block.text}</code>
          </pre>
        ) : (
          // dir="auto": a line that is only maths or English reads left to right.
          <p key={index} dir="auto" className={block.heading ? 'answer-heading' : undefined}>
            {block.parts.map((part, i) => (
              <Part key={i} part={part} />
            ))}
          </p>
        ),
      )}
    </div>
  );
}
