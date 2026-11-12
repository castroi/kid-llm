import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatSummary } from '../core/chat';
import { groupByDay } from '../core/history';
import { CloseIcon, LockIcon, ModeIcon, MoreIcon, PlusIcon } from './icons';

export interface HistoryDrawerProps {
  /** The chat on the screen, marked in the list. */
  currentId: string;
  /** False when the browser has no usable storage: nothing is kept, so there is no list. */
  saved: boolean;
  now: () => number;
  list: () => Promise<ChatSummary[]>;
  /** Each resolves true when it was done. */
  onOpen: (id: string) => Promise<boolean>;
  onRename: (id: string, title: string) => Promise<boolean>;
  onNew: () => void;
  onParentArea: () => void;
  onClose: () => void;
}

type Editing = { id: string; action: 'menu' | 'rename' } | null;

/**
 * Her chats, sliding in from the side: open one, start a new one, or rename. She can't delete
 * a chat: only "delete all" in the parent area removes chats.
 * The way into the parent area is at the bottom.
 */
export function HistoryDrawer({ currentId, saved, now, list, onOpen, onRename, onNew, onParentArea, onClose }: HistoryDrawerProps) {
  const drawer = useRef<HTMLElement>(null);
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [newTitle, setNewTitle] = useState('');
  const [problem, setProblem] = useState('');

  const load = useCallback(() => {
    list().then(setChats, () => {
      setChats([]);
      setProblem('לא הצלחתי לקרוא את השיחות.');
    });
  }, [list]);

  useEffect(load, [load]);

  // Focus goes into the drawer when it opens and back to where it was when it closes.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawer.current?.focus();
    return () => before?.focus();
  }, []);

  const open = async (id: string) => {
    if (await onOpen(id)) onClose();
    else {
      setProblem('השיחה הזאת כבר לא באייפון.');
      load();
    }
  };

  const rename = async (event: FormEvent, id: string) => {
    event.preventDefault();
    if (!newTitle.trim()) return;
    const done = await onRename(id, newTitle);
    setProblem(done ? '' : 'השם לא נשמר.');
    setEditing(null);
    load();
  };

  const toggleMenu = (chat: ChatSummary) => {
    setProblem('');
    setEditing(editing?.id === chat.id ? null : { id: chat.id, action: 'menu' });
  };

  return (
    <div
      className="drawer-layer"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <button type="button" className="scrim" aria-label="סגירה" onClick={onClose} />
      <nav ref={drawer} className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" tabIndex={-1}>
        <div className="drawer-head">
          <h2 id="drawer-title" className="sheet-title">
            השיחות שלי
          </h2>
          <button type="button" className="icon-button" aria-label="סגירת הרשימה" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <button
          type="button"
          className="button primary with-icon"
          onClick={() => {
            onNew();
            onClose();
          }}
        >
          <PlusIcon />
          <span>שיחה חדשה</span>
        </button>

        <div className="drawer-list">
          {!saved && <p className="hint">השיחות לא נשמרות באייפון הזה.</p>}
          {saved && chats !== null && chats.length === 0 && <p className="hint">עוד אין שיחות שמורות.</p>}
          {groupByDay(chats ?? [], now()).map((group) => (
            <section key={group.label} aria-label={group.label}>
              <h3 className="drawer-day">{group.label}</h3>
              <ul className="drawer-chats">
                {group.chats.map((chat) => (
                  <li key={chat.id}>
                    <div className="drawer-row">
                      <button type="button" className="drawer-chat" aria-current={chat.id === currentId ? 'true' : undefined} onClick={() => void open(chat.id)}>
                        <span className="drawer-chat-icon">
                          <ModeIcon mode={chat.mode} size={22} />
                        </span>
                        {/* Her own words: shown as text, in the direction of the language she wrote in. */}
                        <span className="drawer-chat-title" dir="auto">
                          {chat.title}
                        </span>
                      </button>
                      <button type="button" className="icon-button" aria-label={`אפשרויות לשיחה: ${chat.title}`} aria-expanded={editing?.id === chat.id} onClick={() => toggleMenu(chat)}>
                        <MoreIcon />
                      </button>
                    </div>
                    {editing?.id === chat.id && editing.action === 'menu' && (
                      <div className="button-row drawer-actions">
                        <button
                          type="button"
                          className="button"
                          onClick={() => {
                            setNewTitle(chat.title);
                            setEditing({ id: chat.id, action: 'rename' });
                          }}
                        >
                          שינוי שם
                        </button>
                      </div>
                    )}
                    {editing?.id === chat.id && editing.action === 'rename' && (
                      <form className="form drawer-actions" onSubmit={(event) => void rename(event, chat.id)}>
                        <div className="field">
                          <label htmlFor="chat-title">שם השיחה</label>
                          <input id="chat-title" className="input" type="text" autoComplete="off" dir="auto" maxLength={40} value={newTitle} autoFocus onChange={(event) => setNewTitle(event.target.value)} />
                        </div>
                        <div className="button-row">
                          <button type="submit" className="button primary">
                            שמירת השם
                          </button>
                          <button type="button" className="button" onClick={() => setEditing(null)}>
                            ביטול
                          </button>
                        </div>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <p className="status" role="status">
            {problem}
          </p>
        </div>

        {saved && <p className="hint">השיחות נשמרות רק באייפון הזה.</p>}
        <button
          type="button"
          className="button with-icon"
          onClick={() => {
            onClose();
            onParentArea();
          }}
        >
          <LockIcon />
          <span>אזור הורים</span>
        </button>
      </nav>
    </div>
  );
}
