import { FILE_KINDS, startsLike, type ChatFile, type FileKind } from '../ai/files';
import { cut } from './text';

/**
 * A file she attached to a message, as it is kept with the chat on the phone: what is sent
 * (src/ai/files.ts) and, for a document, her own name for it, which is shown to her only.
 */
export interface Attachment extends ChatFile {
  /** A document's name, for the screen only: never sent. Empty for a picture. */
  name: string;
}

/** A picture as it is sent and kept, after the app made it smaller. */
export const MAX_PICTURE_BYTES = 4 * 1024 * 1024;
/** A document as it is sent and kept. In the request it grows by a third (base64). */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
/** A photo as she picked it, before it is made smaller; more than this isn't even opened. */
export const MAX_PICKED_BYTES = 30 * 1024 * 1024;
export const MAX_FILE_NAME_CHARS = 60;

/** She can attach in the modes that talk: not in search (what goes there reaches a search engine) and not in drawing. */
export function canAttachIn(mode: string): boolean {
  return mode === 'chat' || mode === 'math';
}

export type AttachmentProblem = 'unsupported' | 'too-large' | 'unreadable';

export class AttachmentError extends Error {
  constructor(readonly problem: AttachmentProblem) {
    // The kind of problem only: never the file's name or anything from inside it.
    super(problem);
    this.name = 'AttachmentError';
  }
}

/** Characters that hide in a name or change the order it is shown in, and control characters. */
// eslint-disable-next-line no-control-regex
const NOT_FOR_A_NAME = /[\u0000-\u001F\u007F؜​-‏‪-‮⁠-⁩﻿]/g;

/** A file's name as it may be shown: the last part of a path, on one line, without hidden characters, cut short. */
export function displayName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const last = name.split(/[\\/]/).pop() ?? '';
  return cut(last.replace(NOT_FOR_A_NAME, '').replace(/\s+/g, ' ').trim(), MAX_FILE_NAME_CHARS);
}

const limitFor = (kind: FileKind) => (kind === 'image' ? MAX_PICTURE_BYTES : MAX_DOCUMENT_BYTES);

/** A stored attachment as it may be used: a known kind whose bytes start like that kind and have a sane size. Otherwise null. */
export function sanitizeAttachment(raw: unknown): Attachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const { kind, bytes, name } = raw as Record<string, unknown>;
  if (typeof kind !== 'string' || !(FILE_KINDS as readonly string[]).includes(kind)) return null;
  const known = kind as FileKind;
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > limitFor(known) || !startsLike(known, bytes)) return null;
  return { kind: known, bytes, name: known === 'image' ? '' : displayName(name) };
}

/** What the phone gives for a picked file: its bytes, and the name and type it claims. */
export type PickedFile = Pick<Blob, 'size' | 'type' | 'slice' | 'arrayBuffer'> & { name?: string };

/**
 * Makes a picked file ready to attach. What it is comes from its first bytes:
 * - a PDF or a Word file is taken as it is, up to `MAX_DOCUMENT_BYTES`;
 * - a picture is redrawn by `encodeImage` into a smaller JPEG. The redrawn picture holds
 *   only what is seen in it: where and when a photo was taken, and on which phone, stay behind.
 * Anything else is refused. Throws AttachmentError; never keeps or reports the file's content.
 */
export async function prepareAttachment(file: PickedFile, encodeImage: (file: PickedFile) => Promise<ArrayBuffer>): Promise<Attachment> {
  if (file.size === 0) throw new AttachmentError('unreadable');
  if (file.size > MAX_PICKED_BYTES) throw new AttachmentError('too-large');
  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
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
    return { kind: document, bytes, name: displayName(name) };
  }

  // A drawing made of text (SVG) can carry scripts and links; it is not a photo.
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') throw new AttachmentError('unsupported');
  let bytes: ArrayBuffer;
  try {
    bytes = await encodeImage(file);
  } catch {
    throw new AttachmentError('unreadable');
  }
  if (bytes.byteLength === 0 || !startsLike('image', bytes)) throw new AttachmentError('unreadable');
  if (bytes.byteLength > MAX_PICTURE_BYTES) throw new AttachmentError('too-large');
  return { kind: 'image', bytes, name: '' };
}
