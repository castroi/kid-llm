import { siteName } from '../ai/sources';
import { parseAnswer, type Inline, type LinkPart } from '../core/answerText';

/**
 * An address the model wrote. For her it stays text. In a parent's own use a safe https
 * address can be tapped, and the link is shown by its site's name (never by the model's
 * label, which could name another site); it opens outside the app with no referrer.
 */
function Link({ part, links }: { part: LinkPart; links: boolean }) {
  const labelled = part.text !== part.url;
  const site = links ? siteName(part.url) : '';
  if (!site) {
    return (
      <>
        {labelled && `${part.text} `}
        <bdi dir="ltr">{part.url}</bdi>
      </>
    );
  }
  return (
    <>
      {/* A label that is itself an address could pass for another site: only the real site is shown. */}
      {labelled && !part.text.includes('://') && `${part.text} `}
      <a className="source-link" href={new URL(part.url).href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
        <bdi dir="ltr">{site}</bdi>
      </a>
    </>
  );
}

function Part({ part, links }: { part: Inline; links: boolean }) {
  switch (part.kind) {
    case 'link':
      return <Link part={part} links={links} />;
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
 * nothing in it can become HTML, and nothing in it becomes a link she could tap. Only with
 * `links` (a parent's own use) does a safe https address in it become one. (The links under
 * a search answer are not the model's text: they come from the provider's list of sources, src/ai/sources.ts.)
 */
export function AnswerText({ text, links = false }: { text: string; links?: boolean }) {
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
              <Part key={i} part={part} links={links} />
            ))}
          </p>
        ),
      )}
    </div>
  );
}
