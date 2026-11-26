import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Attachment } from '../core/attachment';
import { Composer, type ComposerProps } from './Composer';

const PHOTO: Attachment = { kind: 'image', bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]).buffer, name: '' };

const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:composer');
  URL.revokeObjectURL = vi.fn();
});
afterAll(() => {
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

function props(extra: Partial<ComposerProps> = {}): ComposerProps {
  return { mode: 'chat', model: 'vision-model', writing: false, blocked: false, attach: async () => PHOTO, pictureLimit: 3, onSend: () => true, onStop: () => undefined, onPickMode: () => undefined, ...extra };
}

describe('the message box with files', () => {
  it('tells her, and does not send, when the parent lowered how many pictures a message carries while hers waited', async () => {
    const onSend = vi.fn(() => true);
    const { rerender } = render(<Composer {...props({ onSend })} />);
    const photos = [1, 2, 3].map((n) => new File(['x'], `IMG_${n}.jpg`, { type: 'image/jpeg' }));
    await userEvent.upload(screen.getByLabelText('קובץ לצירוף'), photos);
    await waitFor(() => expect(document.querySelectorAll('.attachment-chip')).toHaveLength(3));
    await userEvent.type(screen.getByLabelText('הודעה'), 'מה בתמונות?');
    expect(screen.getByRole('button', { name: 'שליחה' })).toBeEnabled();

    rerender(<Composer {...props({ onSend, pictureLimit: 1 })} />);
    expect(screen.getByText('אפשר לצרף רק תמונה אחת להודעה. צריך להסיר קובץ לפני השליחה.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'שליחה' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'הסרת קובץ 3' }));
    await userEvent.click(screen.getByRole('button', { name: 'הסרת קובץ 2' }));
    expect(screen.queryByText(/צריך להסיר קובץ/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'שליחה' }));
    expect(onSend).toHaveBeenCalledWith('מה בתמונות?', [PHOTO]);
  });
});
