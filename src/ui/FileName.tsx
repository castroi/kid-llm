import type { Attachment } from '../core/attachment';

/** What a document is called when it has no name: its kind. */
const KIND_NAMES: Record<Attachment['kind'], string> = { image: 'תמונה', pdf: 'PDF', docx: 'Word' };

/**
 * Her name for a file, on one line: a long name gives way in the middle, so its end and its
 * type (".pdf") always stay in view. The type is shown left to right, after the rest of the
 * name, in whichever direction the name itself is written. A file with no name is shown by its kind.
 */
export function FileName({ attachment }: { attachment: Pick<Attachment, 'kind' | 'name'> }) {
  const name = attachment.name || KIND_NAMES[attachment.kind];
  const dot = name.lastIndexOf('.');
  // A type is a short ending after the last dot, not a dot at the start or a long tail.
  const split = dot > 0 && name.length - dot <= 6 ? dot : name.length;
  return (
    <span className="file-name" dir="auto">
      <span className="file-name-start">{name.slice(0, split)}</span>
      {split < name.length && (
        <bdi dir="ltr" className="file-name-end">
          {name.slice(split)}
        </bdi>
      )}
    </span>
  );
}

/** How a file is called for a screen reader: its number, its kind, and her name for it when it has one. */
export function fileLabel(attachment: Pick<Attachment, 'kind' | 'name'>, number: number): string {
  if (attachment.kind === 'image') return attachment.name ? `תמונה ${number}: ${attachment.name}` : `תמונה ${number}`;
  return `קובץ ${number}: ${attachment.name || KIND_NAMES[attachment.kind]}`;
}
