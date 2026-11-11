import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiError } from '../ai/providers';
import { fakeParent, type FakePhone } from '../test/fakeParent';
import { IDLE_CLOSE_MS, ParentArea } from './ParentArea';

const KEY = 'sk-parent-secret';

function open(initial: Partial<FakePhone> = {}, check?: () => Promise<string | null>) {
  const { parent, phone } = fakeParent(initial, check);
  const onClose = vi.fn();
  const onChatsDeleted = vi.fn();
  render(<ParentArea parent={parent} onClose={onClose} onChatsDeleted={onChatsDeleted} />);
  return { phone, onClose, onChatsDeleted };
}

/** Opens the area on a phone whose parent already chose the code 2468. */
async function openSettings(initial: Partial<FakePhone> = {}, check?: () => Promise<string | null>) {
  const opened = open({ pin: '2468', ...initial }, check);
  await userEvent.type(screen.getByLabelText('קוד הורים'), '2468');
  await userEvent.click(screen.getByRole('button', { name: 'כניסה' }));
  await screen.findByRole('heading', { name: 'חיבור' });
  return opened;
}

const settingsShown = () => screen.queryByLabelText('מפתח API') !== null;

describe("the parent's code", () => {
  it('asks a first-time parent to choose a code before showing any setting', async () => {
    const { phone } = open();
    expect(screen.getByRole('heading', { name: 'בחירת קוד הורים' })).toBeInTheDocument();
    expect(settingsShown()).toBe(false);

    await userEvent.type(screen.getByLabelText('קוד חדש (4 עד 8 ספרות)'), '2468');
    await userEvent.type(screen.getByLabelText('שוב, לאימות'), '2468');
    await userEvent.click(screen.getByRole('button', { name: 'שמירת הקוד' }));

    await screen.findByLabelText('מפתח API');
    expect(phone.pin).toBe('2468');
  });

  it('refuses a code that is too short or typed differently the second time', async () => {
    const { phone } = open();
    await userEvent.type(screen.getByLabelText('קוד חדש (4 עד 8 ספרות)'), '12');
    await userEvent.type(screen.getByLabelText('שוב, לאימות'), '12');
    await userEvent.click(screen.getByRole('button', { name: 'שמירת הקוד' }));
    expect(screen.getByText('הקוד צריך להיות 4 עד 8 ספרות.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('קוד חדש (4 עד 8 ספרות)'), '34');
    await userEvent.type(screen.getByLabelText('שוב, לאימות'), '35');
    await userEvent.click(screen.getByRole('button', { name: 'שמירת הקוד' }));
    expect(screen.getByText('שני הקודים לא זהים.')).toBeInTheDocument();
    expect(phone.pin).toBeNull();
    expect(settingsShown()).toBe(false);
  });

  it('takes digits only', async () => {
    open();
    const field = screen.getByLabelText('קוד חדש (4 עד 8 ספרות)') as HTMLInputElement;
    await userEvent.type(field, '1a2-3 4');
    expect(field.value).toBe('1234');
  });

  it('shows the code and the key as dots without using a password field, which Safari would offer to save', async () => {
    await openSettings({ apiKey: KEY });
    await userEvent.click(screen.getByRole('button', { name: 'שינוי קוד הורים' }));
    for (const label of ['מפתח API', 'הקוד הנוכחי', 'קוד חדש (4 עד 8 ספרות)', 'שוב, לאימות']) {
      const field = screen.getByLabelText(label) as HTMLInputElement;
      expect(field.type, label).toBe('text');
      expect(field, label).toHaveClass('secret');
      expect(field.autocomplete, label).toBe('off');
    }
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('starts from nothing when the code is missing but a key and settings are still on the phone', async () => {
    const { phone } = open({ apiKey: KEY, settings: { provider: 'venice', models: { chat: 'm', search: '', math: '', draw: '' }, systemPrompt: 'Be kind.', childName: 'נועה', dailyLimit: 5 } });
    expect(screen.getByText('לא נמצא קוד הורים באייפון הזה. בחירת קוד חדש תמחק את המפתח ואת ההגדרות השמורים.')).toBeInTheDocument();
    // Nothing is removed until a new code is really chosen.
    expect(phone.apiKey).toBe(KEY);

    await userEvent.type(screen.getByLabelText('קוד חדש (4 עד 8 ספרות)'), '9999');
    await userEvent.type(screen.getByLabelText('שוב, לאימות'), '9999');
    await userEvent.click(screen.getByRole('button', { name: 'שמירת הקוד' }));
    await screen.findByLabelText('מפתח API');
    expect(phone.apiKey).toBe('');
    expect(phone.settings.systemPrompt).toBe('');
    expect(phone.settings.dailyLimit).toBeNull();
    expect((screen.getByLabelText('שם הילדה') as HTMLInputElement).value).toBe('');
  });

  it('gives no such warning on a phone that was never set up', () => {
    open();
    expect(screen.queryByText(/לא נמצא קוד הורים/)).not.toBeInTheDocument();
  });

  it('keeps the settings closed after a wrong code and opens them with the right one', async () => {
    const { phone } = open({ pin: '2468' });
    await userEvent.type(screen.getByLabelText('קוד הורים'), '1111');
    await userEvent.click(screen.getByRole('button', { name: 'כניסה' }));
    expect(await screen.findByText('קוד שגוי.')).toBeInTheDocument();
    expect(settingsShown()).toBe(false);
    expect((screen.getByLabelText('קוד הורים') as HTMLInputElement).value).toBe('');

    await userEvent.type(screen.getByLabelText('קוד הורים'), '2468');
    await userEvent.click(screen.getByRole('button', { name: 'כניסה' }));
    await screen.findByLabelText('מפתח API');
    expect(phone.tried).toEqual(['1111', '2468']);
  });

  it('says how long to wait when it is locked, and stays closed even for the right code', async () => {
    open({ pin: '2468', lockedMs: 5 * 60_000 });
    expect(screen.getByText('יותר מדי ניסיונות. אפשר לנסות שוב בעוד 5 דקות.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('קוד הורים'), '2468');
    await userEvent.click(screen.getByRole('button', { name: 'כניסה' }));
    expect(await screen.findByText('יותר מדי ניסיונות. אפשר לנסות שוב בעוד 5 דקות.')).toBeInTheDocument();
    expect(settingsShown()).toBe(false);
  });

  it('closes by itself when the app goes to the background', async () => {
    const { onClose } = await openSettings();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    }
  });

  it('does not change the code without the current one', async () => {
    const { phone } = await openSettings();
    await userEvent.click(screen.getByRole('button', { name: 'שינוי קוד הורים' }));
    await userEvent.type(screen.getByLabelText('הקוד הנוכחי'), '0000');
    await userEvent.type(screen.getByLabelText('קוד חדש (4 עד 8 ספרות)'), '135790');
    await userEvent.type(screen.getByLabelText('שוב, לאימות'), '135790');
    await userEvent.click(screen.getByRole('button', { name: 'החלפת הקוד' }));
    expect(await screen.findByText('הקוד הנוכחי שגוי.')).toBeInTheDocument();
    expect(phone.pin).toBe('2468');
  });

  describe('left open', () => {
    afterEach(() => vi.useRealTimers());

    it('closes after a few minutes with no touch, and a touch starts the wait again', () => {
      vi.useFakeTimers();
      const { onClose } = open({ pin: '2468' });
      vi.advanceTimersByTime(IDLE_CLOSE_MS - 1000);
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.pointerDown(screen.getByLabelText('קוד הורים'));
      vi.advanceTimersByTime(IDLE_CLOSE_MS - 1000);
      expect(onClose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('does not count an empty current code as a try', async () => {
    const { phone } = await openSettings();
    const triesSoFar = phone.tried.length;
    await userEvent.click(screen.getByRole('button', { name: 'שינוי קוד הורים' }));
    await userEvent.type(screen.getByLabelText('קוד חדש (4 עד 8 ספרות)'), '135790');
    await userEvent.type(screen.getByLabelText('שוב, לאימות'), '135790');
    await userEvent.click(screen.getByRole('button', { name: 'החלפת הקוד' }));
    expect(screen.getByText('צריך להזין את הקוד הנוכחי.')).toBeInTheDocument();
    expect(phone.tried).toHaveLength(triesSoFar);
    expect(phone.pin).toBe('2468');
  });

  it('closes at once when wrong current codes lock it', async () => {
    const { phone, onClose } = await openSettings();
    await userEvent.click(screen.getByRole('button', { name: 'שינוי קוד הורים' }));
    phone.lockedMs = 60_000; // the wrong try below is the one that locks it
    await userEvent.type(screen.getByLabelText('הקוד הנוכחי'), '0000');
    await userEvent.type(screen.getByLabelText('קוד חדש (4 עד 8 ספרות)'), '135790');
    await userEvent.type(screen.getByLabelText('שוב, לאימות'), '135790');
    await userEvent.click(screen.getByRole('button', { name: 'החלפת הקוד' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(phone.pin).toBe('2468');
  });

  it('lets the parent change the code', async () => {
    const { phone } = await openSettings();
    await userEvent.click(screen.getByRole('button', { name: 'שינוי קוד הורים' }));
    await userEvent.type(screen.getByLabelText('הקוד הנוכחי'), '2468');
    await userEvent.type(screen.getByLabelText('קוד חדש (4 עד 8 ספרות)'), '135790');
    await userEvent.type(screen.getByLabelText('שוב, לאימות'), '135790');
    await userEvent.click(screen.getByRole('button', { name: 'החלפת הקוד' }));
    expect(await screen.findByText('קוד ההורים הוחלף.')).toBeInTheDocument();
    expect(phone.pin).toBe('135790');
  });
});

describe('the API key', () => {
  it('never shows a saved key, only that there is one', async () => {
    await openSettings({ apiKey: KEY });
    const field = screen.getByLabelText('מפתח API') as HTMLInputElement;
    expect(field.value).toBe('');
    expect(field.placeholder).toBe('מפתח שמור. הקלדה תחליף אותו');
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it('leaves the saved key alone when nothing was typed, and replaces it with a typed one', async () => {
    const { phone } = await openSettings({ apiKey: KEY });
    await userEvent.click(screen.getByRole('button', { name: 'שמירה' }));
    expect(screen.getByText('נשמר.')).toBeInTheDocument();
    expect(phone.apiKey).toBe(KEY);

    await userEvent.type(screen.getByLabelText('מפתח API'), ' sk-new ');
    await userEvent.click(screen.getByRole('button', { name: 'שמירה' }));
    expect(phone.apiKey).toBe('sk-new');
    // Once saved it is gone from the screen.
    expect((screen.getByLabelText('מפתח API') as HTMLInputElement).value).toBe('');
  });

  it('removes the key on request', async () => {
    const { phone } = await openSettings({ apiKey: KEY });
    await userEvent.click(screen.getByRole('button', { name: 'מחיקת המפתח' }));
    expect(phone.apiKey).toBe('');
    expect(screen.queryByRole('button', { name: 'מחיקת המפתח' })).not.toBeInTheDocument();
  });

  it('checks the connection with the typed key, or the saved one when nothing was typed', async () => {
    const { phone } = await openSettings({ apiKey: KEY });
    await userEvent.click(screen.getByRole('button', { name: 'בדיקת חיבור' }));
    expect(await screen.findByText('החיבור תקין.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('מפתח API'), 'sk-typed');
    await userEvent.click(screen.getByRole('button', { name: 'בדיקת חיבור' }));
    expect(phone.checkedWith).toEqual(['', 'sk-typed']);
    // A check saves nothing.
    expect(phone.apiKey).toBe(KEY);
  });

  it('makes no check when there is no key at all', async () => {
    const { phone } = await openSettings();
    await userEvent.click(screen.getByRole('button', { name: 'בדיקת חיבור' }));
    expect(screen.getByText('צריך להזין מפתח קודם.')).toBeInTheDocument();
    expect(phone.checkedWith).toEqual([]);
  });

  it("tells the parent why a key does not work, with the provider's own message", async () => {
    await openSettings({ apiKey: KEY }, () => Promise.reject(new AiError('no-credit', '402 Insufficient balance')));
    await userEvent.click(screen.getByRole('button', { name: 'בדיקת חיבור' }));
    expect(await screen.findByText('נגמרה היתרה בחשבון אצל הספק.')).toBeInTheDocument();
    expect(screen.getByText('402 Insufficient balance')).toBeInTheDocument();
  });

  it("keeps the provider's message on the screen only: nothing is stored, and it is gone when the area is opened again", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const { parent } = fakeParent({ pin: '2468', apiKey: KEY }, () => Promise.reject(new AiError('unauthorized', '401 key rejected for this request')));
    const first = render(<ParentArea parent={parent} onClose={() => undefined} onChatsDeleted={() => undefined} />);
    await userEvent.type(screen.getByLabelText('קוד הורים'), '2468');
    await userEvent.click(screen.getByRole('button', { name: 'כניסה' }));
    await userEvent.click(await screen.findByRole('button', { name: 'בדיקת חיבור' }));
    expect(await screen.findByText('401 key rejected for this request')).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    first.unmount();
    render(<ParentArea parent={parent} onClose={() => undefined} onChatsDeleted={() => undefined} />);
    await userEvent.type(screen.getByLabelText('קוד הורים'), '2468');
    await userEvent.click(screen.getByRole('button', { name: 'כניסה' }));
    await screen.findByLabelText('מפתח API');
    expect(screen.queryByText('401 key rejected for this request')).not.toBeInTheDocument();
  });

  it('survives a check that fails in an unexpected way', async () => {
    await openSettings({ apiKey: KEY }, () => Promise.reject(new Error('boom')));
    await userEvent.click(screen.getByRole('button', { name: 'בדיקת חיבור' }));
    expect(await screen.findByText('התקבלה תשובה לא צפויה מהספק.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('boom');
  });
});

describe('the settings', () => {
  it('shows what is saved and saves what the parent changes', async () => {
    const { phone } = await openSettings({
      settings: { provider: 'venice', models: { chat: 'old-chat', search: '', math: '', draw: 'keep-draw' }, systemPrompt: 'Be kind.', childName: 'נועה', dailyLimit: 30 },
    });
    expect((screen.getByLabelText('מודל למצב "שיחה"') as HTMLInputElement).value).toBe('old-chat');
    expect((screen.getByLabelText('מספר הודעות מרבי ביום') as HTMLInputElement).value).toBe('30');

    await userEvent.clear(screen.getByLabelText('מודל למצב "שיחה"'));
    await userEvent.type(screen.getByLabelText('מודל למצב "שיחה"'), 'new-chat');
    await userEvent.type(screen.getByLabelText('מודל למצב "חשבון"'), 'new-math');
    await userEvent.clear(screen.getByLabelText('הנחיות מערכת (System prompt)'));
    await userEvent.type(screen.getByLabelText('הנחיות מערכת (System prompt)'), 'Short answers.');
    await userEvent.clear(screen.getByLabelText('שם הילדה'));
    await userEvent.type(screen.getByLabelText('שם הילדה'), 'מאיה');
    await userEvent.clear(screen.getByLabelText('מספר הודעות מרבי ביום'));
    await userEvent.type(screen.getByLabelText('מספר הודעות מרבי ביום'), '50');
    await userEvent.click(screen.getByRole('button', { name: 'שמירה' }));

    expect(screen.getByText('נשמר.')).toBeInTheDocument();
    expect(phone.settings).toEqual({
      provider: 'venice',
      // A mode that isn't offered yet keeps what it had.
      models: { chat: 'new-chat', search: '', math: 'new-math', draw: 'keep-draw' },
      systemPrompt: 'Short answers.',
      childName: 'מאיה',
      dailyLimit: 50,
    });
  });

  it('offers a model only for the modes that work today', async () => {
    await openSettings();
    expect(screen.getByLabelText('מודל למצב "חשבון"')).toBeInTheDocument();
    expect(screen.getByLabelText('מודל למצב "חיפוש"')).toBeInTheDocument();
    expect(screen.getByText(/במצב "חיפוש" השאלה שלה נשלחת, דרך הספק, גם למנוע חיפוש/)).toBeInTheDocument();
    expect(screen.queryByLabelText('מודל למצב "ציור"')).not.toBeInTheDocument();
  });

  it('means no limit when the daily limit is left empty, and refuses a limit of zero', async () => {
    const { phone } = await openSettings({ settings: { provider: 'venice', models: { chat: '', search: '', math: '', draw: '' }, systemPrompt: '', childName: '', dailyLimit: 30 } });
    const limit = screen.getByLabelText('מספר הודעות מרבי ביום');
    await userEvent.clear(limit);
    await userEvent.type(limit, '0');
    await userEvent.click(screen.getByRole('button', { name: 'שמירה' }));
    expect(screen.getByText('מספר ההודעות ביום צריך להיות בין 1 ל-1000, או ריק ללא הגבלה.')).toBeInTheDocument();
    expect(phone.settings.dailyLimit).toBe(30);

    await userEvent.clear(limit);
    await userEvent.click(screen.getByRole('button', { name: 'שמירה' }));
    expect(phone.settings.dailyLimit).toBeNull();
  });

  it('says so when the phone refuses to save', async () => {
    const { phone } = await openSettings();
    phone.refuses = true;
    await userEvent.type(screen.getByLabelText('מפתח API'), 'sk-new');
    await userEvent.click(screen.getByRole('button', { name: 'שמירה' }));
    expect(screen.getByText('לא נשמר. ייתכן שהאחסון בדפדפן חסום או מלא.')).toBeInTheDocument();
    // The typed key stays so the parent doesn't have to paste it again.
    expect((screen.getByLabelText('מפתח API') as HTMLInputElement).value).toBe('sk-new');
  });

  it('tells the parent what leaves the phone and what does not', async () => {
    await openSettings();
    expect(screen.getByText('מוצג רק בברכת הפתיחה. לא נשלח לספק.')).toBeInTheDocument();
    expect(screen.getByText(/נשלחות לספק עם כל הודעה, אחרי הנחיות הבטיחות המובנות/)).toBeInTheDocument();
    expect(screen.getByText(/המפתח נשמר רק באייפון הזה/)).toBeInTheDocument();
  });
});

describe('data on the phone', () => {
  it("shows today's count and resets it", async () => {
    const { phone } = await openSettings({ sent: 12 });
    expect(screen.getByText('נשלחו היום: 12 הודעות.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'איפוס הספירה של היום' }));
    expect(screen.getByText('נשלחו היום: 0 הודעות.')).toBeInTheDocument();
    expect(phone.sent).toBe(0);
  });

  it('deletes every chat only after the parent confirms', async () => {
    const { phone, onChatsDeleted } = await openSettings();
    await userEvent.click(screen.getByRole('button', { name: 'מחיקת כל השיחות' }));
    expect(phone.chatsDeleted).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: 'ביטול' }));
    expect(phone.chatsDeleted).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: 'מחיקת כל השיחות' }));
    await userEvent.click(screen.getByRole('button', { name: 'כן, למחוק הכול' }));
    expect(await screen.findByText('כל השיחות נמחקו מהאייפון.')).toBeInTheDocument();
    expect(phone.chatsDeleted).toBe(1);
    expect(onChatsDeleted).toHaveBeenCalledTimes(1);
  });

  it('says so when the deletion fails, and leaves the chat on the screen', async () => {
    const { phone, onChatsDeleted } = await openSettings();
    phone.refuses = true;
    await userEvent.click(screen.getByRole('button', { name: 'מחיקת כל השיחות' }));
    await userEvent.click(screen.getByRole('button', { name: 'כן, למחוק הכול' }));
    expect(await screen.findByText('המחיקה לא הצליחה. כדאי לנסות שוב.')).toBeInTheDocument();
    expect(onChatsDeleted).not.toHaveBeenCalled();
  });
});
