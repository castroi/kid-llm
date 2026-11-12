// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  AttachmentError,
  canAttachIn,
  displayName,
  MAX_DOCUMENT_BYTES,
  MAX_FILE_NAME_CHARS,
  MAX_PICKED_BYTES,
  MAX_PICTURE_BYTES,
  prepareAttachment,
  sanitizeAttachment,
  type PickedFile,
} from './attachment';

const PDF = new TextEncoder().encode('%PDF-1.7 a homework sheet');
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]);
/** A zip that holds a Word document's main part, as every .docx does. */
const DOCX = new Uint8Array([...ZIP, ...new TextEncoder().encode('xxwword/document.xml and the rest')]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

const asJpeg = () => vi.fn(async () => JPEG.slice().buffer);
const never = () => vi.fn(async () => Promise.reject(new Error('should not be called')));

/** A file that only says how big it is, so a test doesn't have to hold 30 MB. */
function sized(size: number, type: string, head: Uint8Array<ArrayBuffer>, name = 'file'): PickedFile {
  return { size, type, name, slice: () => new Blob([head]), arrayBuffer: async () => head.slice().buffer };
}

async function problemOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AttachmentError);
  return (err as AttachmentError).problem;
}

describe('prepareAttachment', () => {
  it('takes a PDF as it is, with her name for it', async () => {
    const encode = never();
    const attachment = await prepareAttachment(new File([PDF], 'דף עבודה.pdf', { type: 'application/pdf' }), encode);
    expect(attachment.kind).toBe('pdf');
    expect(attachment.name).toBe('דף עבודה.pdf');
    expect(new Uint8Array(attachment.bytes)).toEqual(PDF);
    expect(encode).not.toHaveBeenCalled();
  });

  it('knows a PDF by its bytes, whatever its name and type say', async () => {
    const attachment = await prepareAttachment(new File([PDF], 'photo.jpg', { type: 'image/jpeg' }), never());
    expect(attachment.kind).toBe('pdf');
  });

  it('takes a Word file: a zip archive named .docx', async () => {
    const attachment = await prepareAttachment(new File([DOCX], 'חיבור.DOCX', { type: '' }), never());
    expect(attachment.kind).toBe('docx');
    expect(new Uint8Array(attachment.bytes)).toEqual(DOCX);
  });

  it('redraws a picture and keeps only the redrawn one, without a name', async () => {
    const encode = asJpeg();
    const file = new File([PNG], 'IMG_0042.png', { type: 'image/png' });
    const attachment = await prepareAttachment(file, encode);
    expect(encode).toHaveBeenCalledWith(file);
    expect(attachment).toEqual({ kind: 'image', bytes: JPEG.slice().buffer, name: '' });
    // Nothing of the file she picked is in what is kept.
    expect(new Uint8Array(attachment.bytes)).not.toEqual(PNG);
  });

  it('refuses what is not a picture, a PDF or a Word file', async () => {
    const refused = [
      new File(['hello'], 'notes.txt', { type: 'text/plain' }),
      new File(['<html>'], 'page.html', { type: 'text/html' }),
      new File(['<svg onload="x()"/>'], 'drawing.svg', { type: 'image/svg+xml' }),
      // A zip that isn't named .docx, and something only named .pdf.
      new File([DOCX], 'archive.zip', { type: 'application/zip' }),
      // A zip of something else (photos, say) that was only renamed .docx.
      new File([ZIP], 'photos.docx', { type: '' }),
      new File([new Uint8Array([...ZIP, ...new TextEncoder().encode('word/document.xm')])], 'almost.docx', { type: '' }),
      new File(['not a pdf'], 'fake.pdf', { type: 'application/pdf' }),
      new File(['MZ program'], 'fake.docx', { type: '' }),
    ];
    for (const file of refused) expect(await problemOf(prepareAttachment(file, never()))).toBe('unsupported');
  });

  it('refuses a file that is too large, before reading it', async () => {
    expect(await problemOf(prepareAttachment(sized(MAX_PICKED_BYTES + 1, 'image/jpeg', JPEG), never()))).toBe('too-large');
    expect(await problemOf(prepareAttachment(sized(MAX_DOCUMENT_BYTES + 1, 'application/pdf', PDF, 'big.pdf'), never()))).toBe('too-large');
    const huge = vi.fn(async () => {
      const bytes = new Uint8Array(MAX_PICTURE_BYTES + 1);
      bytes.set(JPEG);
      return bytes.buffer;
    });
    expect(await problemOf(prepareAttachment(new File([PNG], 'p.png', { type: 'image/png' }), huge))).toBe('too-large');
  });

  it('says so when a file cannot be opened', async () => {
    expect(await problemOf(prepareAttachment(new File([], 'empty.pdf', { type: 'application/pdf' }), never()))).toBe('unreadable');
    const broken = vi.fn(async () => Promise.reject(new Error('cannot decode IMG_0042.png')));
    expect(await problemOf(prepareAttachment(new File([PNG], 'p.png', { type: 'image/png' }), broken))).toBe('unreadable');
    // What comes back from redrawing has to be a JPEG, and not empty.
    expect(await problemOf(prepareAttachment(new File([PNG], 'p.png', { type: 'image/png' }), async () => PNG.slice().buffer))).toBe('unreadable');
    expect(await problemOf(prepareAttachment(new File([PNG], 'p.png', { type: 'image/png' }), async () => new ArrayBuffer(0)))).toBe('unreadable');
    const unreadable: PickedFile = {
      size: 10,
      type: 'application/pdf',
      name: 'x.pdf',
      slice: () => ({ arrayBuffer: () => Promise.reject(new Error('gone')) }) as unknown as Blob,
      arrayBuffer: () => Promise.reject(new Error('gone')),
    };
    expect(await problemOf(prepareAttachment(unreadable, never()))).toBe('unreadable');
    const halfReadable: PickedFile = { ...sized(PDF.length, 'application/pdf', PDF, 'x.pdf'), arrayBuffer: () => Promise.reject(new Error('gone')) };
    expect(await problemOf(prepareAttachment(halfReadable, never()))).toBe('unreadable');
  });

  it("never puts the file's name or content into the error", async () => {
    const err = await prepareAttachment(new File(['סוד'], 'היומן של נועה.txt', { type: 'text/plain' }), never()).catch((e: unknown) => e);
    expect(String((err as Error).message)).toBe('unsupported');
    expect(JSON.stringify(err)).not.toContain('נועה');
  });
});

describe('displayName', () => {
  it('is the last part of a path, on one line, cut short, without hidden characters', () => {
    expect(displayName('C:\\Users\\noa\\דף.pdf')).toBe('דף.pdf');
    expect(displayName('/private/var/דף\n עבודה.pdf')).toBe('דף עבודה.pdf');
    expect(displayName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(displayName(`${'a'.repeat(200)}.pdf`)).toHaveLength(MAX_FILE_NAME_CHARS);
    expect(displayName(42)).toBe('');
  });
});

describe('sanitizeAttachment', () => {
  it('keeps a file whose bytes are what its kind says', () => {
    expect(sanitizeAttachment({ kind: 'pdf', bytes: PDF.slice().buffer, name: 'דף.pdf', extra: 'x' })).toEqual({ kind: 'pdf', bytes: PDF.slice().buffer, name: 'דף.pdf' });
    expect(sanitizeAttachment({ kind: 'docx', bytes: ZIP.slice().buffer })).toEqual({ kind: 'docx', bytes: ZIP.slice().buffer, name: '' });
    // A picture has no name, whatever was stored.
    expect(sanitizeAttachment({ kind: 'image', bytes: JPEG.slice().buffer, name: 'IMG_0042.jpg' })).toEqual({ kind: 'image', bytes: JPEG.slice().buffer, name: '' });
    // A file the provider refused stays marked, so it is not sent again after the app is reopened.
    expect(sanitizeAttachment({ kind: 'pdf', bytes: PDF.slice().buffer, name: 'a.pdf', refused: true })?.refused).toBe(true);
    expect(sanitizeAttachment({ kind: 'pdf', bytes: PDF.slice().buffer, name: 'a.pdf', refused: 'yes' })).not.toHaveProperty('refused');
  });

  it('drops anything else', () => {
    const bad = [
      null,
      'file',
      {},
      { kind: 'exe', bytes: PDF.slice().buffer },
      { kind: 'pdf', bytes: JPEG.slice().buffer },
      { kind: 'image', bytes: PNG.slice().buffer },
      { kind: 'pdf', bytes: 'JVBERi0=' },
      { kind: 'pdf', bytes: new ArrayBuffer(0) },
      { kind: 7, bytes: PDF.slice().buffer },
    ];
    for (const raw of bad) expect(sanitizeAttachment(raw)).toBeNull();
    const tooBig = new Uint8Array(MAX_DOCUMENT_BYTES + 1);
    tooBig.set(PDF);
    expect(sanitizeAttachment({ kind: 'pdf', bytes: tooBig.buffer })).toBeNull();
  });
});

describe('canAttachIn', () => {
  it('is the modes that talk: never search or drawing', () => {
    expect(['chat', 'math', 'search', 'draw', 'other'].filter(canAttachIn)).toEqual(['chat', 'math']);
  });
});
