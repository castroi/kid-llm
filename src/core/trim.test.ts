// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Attachment } from './attachment';
import { toProviderMessages, type Chat, type StoredMessage } from './chat';
import { dueTrims, KEEP_FILES_MS, thumbnailKey, withTrimmed } from './trim';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const OLD = NOW - KEEP_FILES_MS - 1;

const pdf = (name = 'דף של נועה.pdf'): Attachment => ({ kind: 'pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1]).buffer, name });
const photo = (size = 100, name = 'הכיתה שלי.jpg'): Attachment => {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff]);
  return { kind: 'image', bytes: bytes.buffer, name };
};
const small = () => new Uint8Array([0xff, 0xd8, 0xff, 9]).buffer;

function message(id: string, at: number, extra: Partial<StoredMessage> = {}): StoredMessage {
  return { id, role: 'user', text: 'מה כתוב כאן?', at, mode: 'chat', ...extra };
}

function chatOf(...messages: StoredMessage[]): Chat {
  return { id: 'c1', title: 'דף', mode: 'chat', createdAt: 0, updatedAt: NOW, messages };
}

describe('which files are due to be trimmed', () => {
  it('are her files older than two weeks, but never those of her newest message with files', () => {
    const chat = chatOf(
      message('old', OLD, { attachments: [photo(), pdf()] }),
      message('answer', OLD + 1, { role: 'assistant', text: 'תרגיל' }),
      message('recent', NOW - DAY, { attachments: [pdf()] }),
      message('newest', OLD + 2, { attachments: [photo()] }),
      message('words', OLD + 3),
    );
    // "recent" is too young; "newest" is her newest message with files, however old.
    expect(dueTrims(chat, NOW)).toEqual([
      { messageId: 'old', index: 0, kind: 'image' },
      { messageId: 'old', index: 1, kind: 'pdf' },
    ]);
  });

  it('are none on a message dated after the clock, none already trimmed, and none at exactly two weeks', () => {
    const chat = chatOf(
      message('future', NOW + DAY, { attachments: [photo()] }),
      message('done', OLD, { attachments: [{ ...photo(), trimmed: true }] }),
      message('edge', NOW - KEEP_FILES_MS, { attachments: [pdf()] }),
      message('newest', NOW, { attachments: [pdf()] }),
    );
    expect(dueTrims(chat, NOW)).toEqual([]);
  });
});

describe('trimming', () => {
  const chat = chatOf(message('old', OLD, { attachments: [photo(), pdf()] }), message('newest', NOW, { attachments: [pdf()] }));

  it('keeps a small copy of a picture and a note of a document, without her names for them', () => {
    const trimmed = withTrimmed(chat, NOW, new Map([[thumbnailKey({ messageId: 'old', index: 0 }), small()]]));
    expect(trimmed?.messages[0].attachments).toEqual([
      { kind: 'image', bytes: small(), name: '', trimmed: true },
      { kind: 'pdf', bytes: new ArrayBuffer(0), name: '', trimmed: true },
    ]);
    // Her newest message with files is untouched, and so is the chat it was made from.
    expect(trimmed?.messages[1]).toBe(chat.messages[1]);
    expect(chat.messages[0].attachments?.[0].name).toBe('הכיתה שלי.jpg');
    expect(JSON.stringify(trimmed?.messages[0])).not.toContain('נועה');
  });

  it('keeps a picture whole when no small copy of it was made, and the picture itself when the copy is not smaller', () => {
    const noCopy = withTrimmed(chat, NOW, new Map());
    expect(noCopy?.messages[0].attachments?.[0]).toEqual(photo());
    expect(noCopy?.messages[0].attachments?.[1].trimmed).toBe(true);
    const tiny = chatOf(message('old', OLD, { attachments: [photo(3)] }), message('newest', NOW, { attachments: [pdf()] }));
    const kept = withTrimmed(tiny, NOW, new Map([[thumbnailKey({ messageId: 'old', index: 0 }), small()]]));
    expect(kept?.messages[0].attachments?.[0]).toEqual({ kind: 'image', bytes: photo(3).bytes, name: '', trimmed: true });
  });

  it('changes nothing that is no longer due, and says so', () => {
    expect(withTrimmed(chatOf(message('newest', OLD, { attachments: [pdf()] })), NOW, new Map())).toBeNull();
    // A small copy made for a file that is no longer there does nothing.
    expect(withTrimmed(chatOf(message('newest', NOW, { attachments: [photo()] })), NOW, new Map([[thumbnailKey({ messageId: 'newest', index: 0 }), small()]]))).toBeNull();
  });

  it('keeps the mark of a file the provider refused', () => {
    const refused = chatOf(message('old', OLD, { attachments: [{ ...pdf(), refused: true }] }), message('newest', NOW, { attachments: [pdf()] }));
    expect(withTrimmed(refused, NOW, new Map())?.messages[0].attachments?.[0]).toEqual({ kind: 'pdf', bytes: new ArrayBuffer(0), name: '', trimmed: true, refused: true });
  });

  it('never sends what was trimmed to a model, and keeps the numbers of the rest', () => {
    const talk = [message('q', OLD, { attachments: [{ ...photo(), trimmed: true }, pdf(), { ...pdf(), bytes: new ArrayBuffer(0), name: '', trimmed: true }] })];
    expect(toProviderMessages(talk)[0].files?.map((file) => [file.kind, file.number])).toEqual([['pdf', 2]]);
    expect(toProviderMessages([message('q', OLD, { attachments: [{ ...photo(), trimmed: true }] })])[0]).not.toHaveProperty('files');
  });
});
