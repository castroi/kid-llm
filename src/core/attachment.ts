import { FILE_KINDS, startsLike, type ChatFile, type FileKind } from '../ai/files';
import { cut } from './text';

/**
 * A file she attached to a message, as it is kept with the chat on the phone: what is sent
 * (src/ai/files.ts) and her own name for it, which is shown to her only.
 */
export interface Attachment extends ChatFile {
  /**
   * Her name for the file, for the screen only: never sent. Empty for a picture whose name
   * says nothing (`image.jpg`, `IMG_1234.HEIC`): the screen calls it by its number then.
   */
  name: string;
  /**
   * The provider would not take this file. It stays with her message on the phone but is
   * not sent again, so one refused file doesn't make every later message of the chat fail.
   */
  refused?: true;
  /**
   * Kept whole for `KEEP_FILES_DAYS` only (src/core/trim.ts): after that a picture is kept as a
   * small copy and a document as a note of its kind, with no bytes; her name for it goes too.
   * Never sent to a model again.
   */
  trimmed?: true;
}

/** A picture as it is sent and kept, after the app made it smaller. */
export const MAX_PICTURE_BYTES = 4 * 1024 * 1024;
/**
 * A document as it is sent and kept. In the request it grows by a third (base64), and it is
 * sent again (and paid for again) with every follow-up, on top of the limit on the chat's text.
 */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
/** A photo as she picked it, before it is made smaller; more than this isn't even opened. */
export const MAX_PICKED_BYTES = 30 * 1024 * 1024;
export const MAX_FILE_NAME_CHARS = 60;

/** The most documents one message carries. */
export const MAX_DOCUMENTS = 5;
/** The most pictures one message carries; fewer when the model for files reads fewer (`pictureLimitFor`, src/storage/settings.ts). */
export const MAX_PICTURES = 5;
/** All the files of one message together, as they are kept: they are sent again with every later message. */
export const MAX_MESSAGE_FILE_BYTES = 10 * 1024 * 1024;
/** The longest side of a picture when it is her only one in the message, and when there are more (src/main.tsx redraws them). */
export const PICTURE_SIDE = 1568;
export const SMALLER_PICTURE_SIDE = 1024;

/** She can attach in the modes that talk: not in search (what goes there reaches a search engine) and not in drawing. */
export function canAttachIn(mode: string): boolean {
  return mode === 'chat' || mode === 'math';
}

export type AttachmentProblem = 'unsupported' | 'too-large' | 'unreadable';

/** Why a file that opened fine still can't go with this message: one limit of the message is reached. */
export type LimitProblem = 'pictures' | 'documents' | 'size';

/** Whether one more file fits the message, and if not, which limit it hits. */
export function limitFor(attached: readonly Attachment[], next: Attachment, pictureLimit: number): LimitProblem | null {
  const pictures = attached.filter((a) => a.kind === 'image').length;
  if (next.kind === 'image' && pictures >= pictureLimit) return 'pictures';
  if (next.kind !== 'image' && attached.length - pictures >= MAX_DOCUMENTS) return 'documents';
  const bytes = attached.reduce((sum, a) => sum + a.bytes.byteLength, 0);
  if (bytes + next.bytes.byteLength > MAX_MESSAGE_FILE_BYTES) return 'size';
  return null;
}

/** The files as they may go with one message: in their order, as many as fit the limits. */
export function withinLimits(attachments: readonly Attachment[], pictureLimit: number): Attachment[] {
  const kept: Attachment[] = [];
  for (const attachment of attachments) if (limitFor(kept, attachment, pictureLimit) === null) kept.push(attachment);
  return kept;
}

export class AttachmentError extends Error {
  constructor(readonly problem: AttachmentProblem) {
    // The kind of problem only: never the file's name or anything from inside it.
    super(problem);
    this.name = 'AttachmentError';
  }
}

/** Characters that hide in a name or change the order it is shown in, and control characters. */
// eslint-disable-next-line no-control-regex
const NOT_FOR_A_NAME = /[\u0000-\u001F\u007F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/** A file's name as it may be shown: the last part of a path, on one line, without hidden characters, cut short, its type (".pdf") kept. */
export function displayName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const last = name.split(/[\\/]/).pop() ?? '';
  const clean = last.replace(NOT_FOR_A_NAME, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_FILE_NAME_CHARS) return clean;
  const type = /\.[A-Za-z0-9]{1,5}$/.exec(clean)?.[0] ?? '';
  return `${cut(clean.slice(0, clean.length - type.length), MAX_FILE_NAME_CHARS - type.length).trimEnd()}${type}`;
}

const bytesFor = (kind: FileKind) => (kind === 'image' ? MAX_PICTURE_BYTES : MAX_DOCUMENT_BYTES);

/**
 * A name the phone made up for a photo, which tells her nothing: `image.jpg`, `IMG_1234.HEIC`,
 * `IMG_E1234`, `IMG_0042_home.png`, `Photo 3.png`, a UUID, digits only.
 */
const MADE_UP_PICTURE_NAME = /^(image|photo|picture|img|img[_-]?e?\d+(?:[\s_-][^.]*)?|photo[\s_-].*|\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.[a-z0-9]{1,5})?$/i;

/** A picture's name as it is kept: her own name for it, or empty when the phone made it up. */
export function pictureName(name: unknown): string {
  const shown = displayName(name);
  return MADE_UP_PICTURE_NAME.test(shown) ? '' : shown;
}

/** A stored attachment as it may be used: a known kind whose bytes start like that kind and have a sane size. Otherwise null. */
export function sanitizeAttachment(raw: unknown): Attachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const { kind, bytes, name, refused, trimmed } = raw as Record<string, unknown>;
  if (typeof kind !== 'string' || !(FILE_KINDS as readonly string[]).includes(kind)) return null;
  const known = kind as FileKind;
  // A trimmed file has lost her name for it; a trimmed document has lost its bytes too.
  if (trimmed === true) {
    const marks = { trimmed: true as const, ...(refused === true ? { refused: true as const } : {}) };
    if (known !== 'image') return bytes instanceof ArrayBuffer && bytes.byteLength === 0 ? { kind: known, bytes, name: '', ...marks } : null;
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > MAX_PICTURE_BYTES || !startsLike('image', bytes)) return null;
    return { kind: known, bytes, name: '', ...marks };
  }
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > bytesFor(known) || !startsLike(known, bytes)) return null;
  return { kind: known, bytes, name: known === 'image' ? pictureName(name) : displayName(name), ...(refused === true ? { refused: true as const } : {}) };
}

/** The name of the part every Word file holds. A zip's part names are written in it as plain text. */
const WORD_PART = Array.from('word/document.xml', (letter) => letter.charCodeAt(0));

/** True when the zip holds a Word document's main part: a zip of photos renamed ".docx" does not. */
function holdsWordDocument(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes);
  const first = WORD_PART[0];
  for (let at = view.indexOf(first); at !== -1 && at + WORD_PART.length <= view.length; at = view.indexOf(first, at + 1)) {
    if (WORD_PART.every((code, offset) => view[at + offset] === code)) return true;
  }
  return false;
}

/** How a picture file starts: JPEG, PNG, GIF, WebP ("RIFF" … "WEBP"), or HEIC/HEIF ("ftyp" at byte 4). */
function looksLikePicture(head: Uint8Array): boolean {
  const at = (offset: number, text: string) => Array.from(text).every((letter, i) => head[offset + i] === letter.charCodeAt(0));
  return (
    (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
    (head[0] === 0x89 && at(1, 'PNG')) ||
    at(0, 'GIF8') ||
    (at(0, 'RIFF') && at(8, 'WEBP')) ||
    at(4, 'ftyp')
  );
}

/** What the phone gives for a picked file: its bytes, and the name and type it claims. */
export type PickedFile = Pick<Blob, 'size' | 'type' | 'slice' | 'arrayBuffer'> & { name?: string };

/**
 * Makes a picked file ready to attach. What it is comes from its first bytes:
 * - a PDF or a Word file (a zip named .docx that holds a Word document) is taken as it is, up to `MAX_DOCUMENT_BYTES`;
 * - a picture is redrawn by `encodeImage` into a smaller JPEG, its longest side at most
 *   `PICTURE_SIDE`, or `SMALLER_PICTURE_SIDE` when `smaller` (the message has more than one
 *   picture). The redrawn picture holds only what is seen in it: where and when a photo was
 *   taken, and on which phone, stay behind. A picture is known by its declared type, or by its
 *   first bytes when the phone declares none (the Files app may not).
 * Anything else is refused. Throws AttachmentError; never keeps or reports the file's content.
 */
export async function prepareAttachment(file: PickedFile, encodeImage: (file: PickedFile, maxSide: number) => Promise<ArrayBuffer>, smaller = false): Promise<Attachment> {
  if (file.size === 0) throw new AttachmentError('unreadable');
  if (file.size > MAX_PICKED_BYTES) throw new AttachmentError('too-large');
  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  } catch {
    throw new AttachmentError('unreadable');
  }
  const name = typeof file.name === 'string' ? file.name : '';

  const document: FileKind | null = startsLike('pdf', head) ? 'pdf' : startsLike('docx', head) && /\.docx$/i.test(name) ? 'docx' : null;
  if (document) {
    if (file.size > MAX_DOCUMENT_BYTES) throw new AttachmentError('too-large');
    let bytes: ArrayBuffer;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      throw new AttachmentError('unreadable');
    }
    if (document === 'docx' && !holdsWordDocument(bytes)) throw new AttachmentError('unsupported');
    return { kind: document, bytes, name: displayName(name) };
  }

  // A drawing made of text (SVG) can carry scripts and links; it is not a photo.
  const picture = file.type === '' ? looksLikePicture(head) : file.type.startsWith('image/') && file.type !== 'image/svg+xml';
  if (!picture) throw new AttachmentError('unsupported');
  let bytes: ArrayBuffer;
  try {
    bytes = await encodeImage(file, smaller ? SMALLER_PICTURE_SIDE : PICTURE_SIDE);
  } catch {
    throw new AttachmentError('unreadable');
  }
  if (bytes.byteLength === 0 || !startsLike('image', bytes)) throw new AttachmentError('unreadable');
  if (bytes.byteLength > MAX_PICTURE_BYTES) throw new AttachmentError('too-large');
  return { kind: 'image', bytes, name: pictureName(name) };
}
