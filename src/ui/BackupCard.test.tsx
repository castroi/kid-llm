import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { BackupError } from '../core/backup';
import { fakeParent, type FakePhone } from '../test/fakeParent';
import { BackupCard } from './BackupCard';

function open(initial: Partial<FakePhone> = {}) {
  const { parent, phone } = fakeParent(initial);
  render(<BackupCard parent={parent} />);
  return phone;
}

const make = () => userEvent.click(screen.getByRole('button', { name: 'הכנת קובץ גיבוי' }));
const save = () => userEvent.click(screen.getByRole('button', { name: 'שמירת הקובץ' }));
const ready = (text: string) => screen.findByText((_, element) => element?.tagName === 'P' && element.textContent === text);
const pick = (file: File) => userEvent.upload(screen.getByLabelText('קובץ גיבוי לייבוא'), file);

describe('backup in the parent area', () => {
  it('says what a backup holds, that the key, the code and the settings are never in it, and that it is not encrypted', () => {
    open();
    expect(screen.getByText(/מפתח ה-API, קוד ההורים וההגדרות אף פעם לא נמצאים בו\. הקובץ לא מוצפן/)).toBeInTheDocument();
    expect(screen.getByText(/שיחה שכבר נמצאת באייפון לא משתנה, ושום דבר לא נמחק/)).toBeInTheDocument();
  });

  it('makes the file first, and hands it over only on a second tap', async () => {
    const phone = open({ chats: 2 });
    expect(screen.queryByRole('button', { name: 'שמירת הקובץ' })).toBeNull();

    await make();
    expect(await ready('הקובץ מוכן: 2 שיחות, 2 KB.')).toBeInTheDocument();
    expect(phone.handed).toEqual([]);

    await save();
    expect(await screen.findByText('הקובץ נמסר. כדאי לוודא שהוא נשמר במקום פרטי.')).toBeInTheDocument();
    expect(phone.handed).toHaveLength(1);
    expect(phone.handed[0].file.name).toBe('kid-llm-backup-2026-11-16.kidllm');
  });

  it.each([
    ['downloaded', 'הקובץ ירד למכשיר. כדאי לשמור אותו במקום פרטי.'],
    ['cancelled', 'השמירה בוטלה. הקובץ עדיין מוכן.'],
    ['failed', 'חלון השיתוף לא נפתח. כדאי לנסות שוב.'],
  ] as const)('says how the hand-over ended: %s', async (handOver, text) => {
    open({ handOver });
    await make();
    await ready('הקובץ מוכן: 2 שיחות, 2 KB.');
    await save();
    expect(await screen.findByText(text)).toBeInTheDocument();
    // The file is still there to try again.
    expect(screen.getByRole('button', { name: 'שמירת הקובץ' })).toBeInTheDocument();
  });

  it('with no chats there is nothing to hand over', async () => {
    open({ chats: 0 });
    await make();
    expect(await screen.findByText('אין שיחות באייפון, אז אין מה לגבות.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'שמירת הקובץ' })).toBeNull();
  });

  it('says so when the file could not be made', async () => {
    open({ refuses: true });
    await make();
    expect(await screen.findByText('הכנת הגיבוי לא הצליחה. כדאי לנסות שוב.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'שמירת הקובץ' })).toBeNull();
  });

  it('imports the picked file and says what was added and what was left alone', async () => {
    const phone = open({ importGives: { added: 3, kept: 1, unreadable: 0, ended: 'whole' } });
    const file = new File(['kid-llm backup 1\n'], 'kid-llm-backup-2026-11-16.kidllm');
    await pick(file);
    expect(await screen.findByText('נוספו 3 שיחות. שיחה אחת כבר הייתה באייפון ולא שונתה.')).toBeInTheDocument();
    expect(phone.imported).toEqual([file]);
    // The same file can be picked again.
    await pick(file);
    expect(phone.imported).toHaveLength(2);
  });

  it('tells a file that is not a backup from an import that failed', async () => {
    const phone = open({ importGives: new BackupError() });
    await pick(new File(['%PDF-1.7'], 'דף עבודה.pdf'));
    expect(await screen.findByText('זה לא קובץ גיבוי של האפליקציה. שום דבר לא יובא.')).toBeInTheDocument();

    phone.importGives = new Error('no storage');
    await pick(new File(['x'], 'x.kidllm'));
    expect(await screen.findByText('הייבוא לא הצליח. שום דבר לא יובא.')).toBeInTheDocument();
  });
});
