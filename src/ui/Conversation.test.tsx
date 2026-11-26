import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StoredMessage } from '../core/chat';
import { Conversation } from './Conversation';

const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:small');
  URL.revokeObjectURL = vi.fn();
});
afterAll(() => {
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

const small = new Uint8Array([0xff, 0xd8, 0xff, 1]).buffer;
const hers: StoredMessage = {
  id: 'q',
  role: 'user',
  text: 'מה כתוב בקובץ 2?',
  at: 1,
  mode: 'chat',
  attachments: [
    { kind: 'image', bytes: small, name: '', trimmed: true },
    { kind: 'pdf', bytes: new ArrayBuffer(0), name: '', trimmed: true },
  ],
};

describe('what is left of files older than two weeks', () => {
  it('shows a small copy of a picture, marked as one, and a note of a document by its number and kind', async () => {
    render(<Conversation messages={[hers]} writing={false} onRetry={() => undefined} copyText={async () => undefined} />);
    const bubble = document.querySelector('.bubble') as HTMLElement;
    expect(within(bubble).getByText('עותק קטן')).toBeInTheDocument();
    expect(bubble.querySelector('img')).toHaveAttribute('alt', 'תמונה 1 שצירפתי (עותק קטן)');
    expect(bubble.querySelector('.attached-file.trimmed')?.textContent).toBe('2קובץ 2, PDF · הקובץ נמחק אחרי שבועיים');

    await userEvent.click(screen.getByRole('button', { name: 'תמונה 1 (עותק קטן): הגדלה' }));
    expect(within(screen.getByRole('dialog')).getByText('נשמר רק עותק קטן של התמונה')).toBeInTheDocument();
  });
});
