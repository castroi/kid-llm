// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  AttachmentError,
  canAttachIn,
  displayName,
  limitFor,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENTS,
  MAX_FILE_NAME_CHARS,
  MAX_MESSAGE_FILE_BYTES,
  MAX_PICKED_BYTES,
  MAX_PICTURE_BYTES,
  PICTURE_SIDE,
  pictureName,
  prepareAttachment,
  sanitizeAttachment,
  SMALLER_PICTURE_SIDE,
  withinLimits,
  type Attachment,
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

  it('redraws a picture and keeps only the redrawn one, without a name the phone made up', async () => {
    const encode = asJpeg();
    const file = new File([PNG], 'IMG_0042.png', { type: 'image/png' });
    const attachment = await prepareAttachment(file, encode);
    expect(encode).toHaveBeenCalledWith(file, PICTURE_SIDE);
    expect(attachment).toEqual({ kind: 'image', bytes: JPEG.slice().buffer, name: '' });
    // Nothing of the file she picked is in what is kept.
    expect(new Uint8Array(attachment.bytes)).not.toEqual(PNG);
  });

  it("keeps her own name for a picture, and redraws it smaller when it isn't the message's only one", async () => {
    const encode = asJpeg();
    const file = new File([PNG], 'הלוח בכיתה.png', { type: 'image/png' });
    expect((await prepareAttachment(file, encode, true)).name).toBe('הלוח בכיתה.png');
    expect(encode).toHaveBeenCalledWith(file, SMALLER_PICTURE_SIDE);
  });

  it('knows a picture by its first bytes when the phone says nothing of its type', async () => {
    const heic = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode('ftypheic'), 1]);
    const webp = new Uint8Array([...new TextEncoder().encode('RIFF'), 1, 2, 3, 4, ...new TextEncoder().encode('WEBP')]);
    for (const head of [JPEG, PNG, heic, webp, new TextEncoder().encode('GIF89a')]) {
      expect((await prepareAttachment(new File([head], 'x', { type: '' }), asJpeg())).kind).toBe('image');
    }
    expect(await problemOf(prepareAttachment(new File(['<svg/>'], 'x', { type: '' }), never()))).toBe('unsupported');
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
    // A picture keeps her name for it, not one the phone made up.
    expect(sanitizeAttachment({ kind: 'image', bytes: JPEG.slice().buffer, name: 'IMG_0042.jpg' })).toEqual({ kind: 'image', bytes: JPEG.slice().buffer, name: '' });
    expect(sanitizeAttachment({ kind: 'image', bytes: JPEG.slice().buffer, name: 'הכיתה\u202E.jpg' })?.name).toBe('הכיתה.jpg');
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

describe('pictureName', () => {
  it('drops the names a phone makes up for a photo, and keeps hers', () => {
    for (const made of ['image.jpg', 'image.jpeg', 'IMG_1234.HEIC', 'IMG_E1234.jpg', 'IMG_0042_home.png', 'img-0042.png', 'Photo 3.png', 'photo_2024.jpg', '1700000000.jpg', '3F2504E0-4F89-11D3-9A0C-0305E82C3301.jpeg', 'image']) {
      expect(pictureName(made)).toBe('');
    }
    expect(pictureName('הלוח בכיתה.jpg')).toBe('הלוח בכיתה.jpg');
    expect(pictureName('homework page 2.png')).toBe('homework page 2.png');
    expect(pictureName(undefined)).toBe('');
  });
});

describe('the limits of one message', () => {
  const doc = (size = 10): Attachment => ({ kind: 'pdf', bytes: new ArrayBuffer(size), name: 'a.pdf' });
  const pic = (size = 10): Attachment => ({ kind: 'image', bytes: new ArrayBuffer(size), name: '' });

  it('takes pictures up to the limit it is given, and documents up to 5', () => {
    expect(limitFor([pic(), pic()], pic(), 3)).toBeNull();
    expect(limitFor([pic(), pic(), pic()], pic(), 3)).toBe('pictures');
    expect(limitFor([], pic(), 1)).toBeNull();
    expect(limitFor([pic()], pic(), 1)).toBe('pictures');
    // Pictures and documents are counted apart.
    expect(limitFor([pic()], doc(), 1)).toBeNull();
    const docs = Array.from({ length: MAX_DOCUMENTS }, () => doc());
    expect(limitFor(docs, doc(), 5)).toBe('documents');
    expect(limitFor(docs, pic(), 5)).toBeNull();
  });

  it('takes no more bytes than one message may carry, all its files together', () => {
    const half = MAX_MESSAGE_FILE_BYTES / 2;
    expect(limitFor([doc(half)], doc(half), 5)).toBeNull();
    expect(limitFor([doc(half)], doc(half + 1), 5)).toBe('size');
  });

  it('keeps the files that fit, in their order', () => {
    const [a, b, c, d] = [pic(1), doc(2), pic(3), pic(4)];
    expect(withinLimits([a, b, c, d], 2)).toEqual([a, b, c]);
    expect(withinLimits([], 2)).toEqual([]);
  });
});

describe('canAttachIn', () => {
  it('is the modes that talk: never search or drawing', () => {
    expect(['chat', 'math', 'search', 'draw', 'other'].filter(canAttachIn)).toEqual(['chat', 'math']);
  });
});
