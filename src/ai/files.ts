/**
 * A file she attached to a message, as it goes to the provider: a picture (always a JPEG
 * the app made itself, so it carries no location or camera data), a PDF or a Word file.
 * Her own name for the file is not part of this and is never sent.
 */
export const FILE_KINDS = ['image', 'pdf', 'docx'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export interface ChatFile {
  kind: FileKind;
  bytes: ArrayBuffer;
}

/** The type each kind is sent as. */
export const FILE_TYPES: Record<FileKind, string> = {
  image: 'image/jpeg',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** The name a document is sent under: a fixed one, because her own file name can hold her name or her school's. */
export const SENT_FILE_NAMES: Record<Exclude<FileKind, 'image'>, string> = { pdf: 'document.pdf', docx: 'document.docx' };

/** How each kind of file starts. A file is what its first bytes say, never what its name or declared type says. */
const SIGNATURES: Record<FileKind, readonly number[]> = {
  image: [0xff, 0xd8, 0xff], // JPEG
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d], // "%PDF-"
  docx: [0x50, 0x4b, 0x03, 0x04], // a zip archive, which a Word file is
};

/** True when the bytes start the way a file of this kind does. */
export function startsLike(kind: FileKind, bytes: ArrayBuffer | Uint8Array): boolean {
  const head = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const signature = SIGNATURES[kind];
  return head.length >= signature.length && signature.every((byte, index) => head[index] === byte);
}

/** The bytes as base64 text. Built in pieces: one call over a whole photo overflows the call stack. */
export function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  const PIECE = 0x8000;
  let binary = '';
  for (let at = 0; at < view.length; at += PIECE) binary += String.fromCharCode(...view.subarray(at, at + PIECE));
  return btoa(binary);
}

/** The file as a `data:` address, which is how it travels inside the request (it is never uploaded anywhere on its own). */
export function dataUrl(file: ChatFile): string {
  return `data:${FILE_TYPES[file.kind]};base64,${toBase64(file.bytes)}`;
}
