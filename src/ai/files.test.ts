// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { dataUrl, startsLike, toBase64 } from './files';

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

describe('files', () => {
  it('tells what a file is from its first bytes', () => {
    expect(startsLike('image', bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
    expect(startsLike('pdf', new TextEncoder().encode('%PDF-1.7'))).toBe(true);
    expect(startsLike('docx', bytes(0x50, 0x4b, 0x03, 0x04, 0x14))).toBe(true);
    // A PNG is not what the app sends as a picture; a short or empty file is nothing.
    expect(startsLike('image', bytes(0x89, 0x50, 0x4e, 0x47))).toBe(false);
    expect(startsLike('pdf', bytes(0x25, 0x50))).toBe(false);
    expect(startsLike('docx', new ArrayBuffer(0))).toBe(false);
    expect(startsLike('pdf', new TextEncoder().encode('<script>'))).toBe(false);
  });

  it('writes bytes as base64, also when there are more than fit in one piece', () => {
    expect(toBase64(bytes(72, 105))).toBe('SGk=');
    expect(toBase64(new ArrayBuffer(0))).toBe('');
    const large = new Uint8Array(100_000).fill(65);
    const text = toBase64(large.buffer);
    expect(text).toHaveLength(Math.ceil(100_000 / 3) * 4);
    expect(atob(text)).toBe('A'.repeat(100_000));
  });

  it('puts a file in a data address of its own type', () => {
    expect(dataUrl({ kind: 'image', bytes: bytes(0xff, 0xd8, 0xff) })).toBe('data:image/jpeg;base64,/9j/');
    expect(dataUrl({ kind: 'pdf', bytes: bytes(72, 105) })).toBe('data:application/pdf;base64,SGk=');
    expect(dataUrl({ kind: 'docx', bytes: bytes(72, 105) })).toBe('data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,SGk=');
  });
});
