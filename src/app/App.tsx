import { useState } from 'react';
import { kidMessage, LIMIT_MESSAGE, NOT_SAVED_MESSAGE, SETUP_MESSAGE } from '../core/kidMessages';
import { isReady, MODES, type ModeId } from '../core/modes';
import { missingFor } from '../storage/settings';
import { Composer } from '../ui/Composer';
import { Conversation } from '../ui/Conversation';
import { ModeIcon, PlusIcon, RetryIcon } from '../ui/icons';
import { ModeSheet } from '../ui/ModeSheet';
import { useChat, type Services } from './useChat';

/** The chat screen: the opening with the modes, then the conversation, with the composer below. */
export function App({ services }: { services: Services }) {
  const { chat, mode, writing, notice, notSaved, setMode, send, stop, retry, startNewChat } = useChat(services);
  const [pickingMode, setPickingMode] = useState(false);
  // Read once for the screen; every send reads the settings again, so a change takes effect at once.
  // Only what the screen shows is kept: her name and which modes are set up, never the key itself.
  const [setup] = useState(() => {
    const settings = services.loadSettings();
    const apiKey = services.loadApiKey(settings.provider);
    const notSetUp = MODES.filter((m) => missingFor(m.id, settings, apiKey) !== null).map((m) => m.id);
    return { childName: settings.childName, notSetUp: notSetUp as readonly ModeId[] };
  });

  const blocked = setup.notSetUp.includes(mode);
  const empty = chat.messages.length === 0;
  const error = notice?.kind === 'error' ? kidMessage(notice.reason) : null;

  return (
    <div className="screen">
      {/* While the mode picker is open, nothing behind it can be reached. */}
      <div className="screen-content" inert={pickingMode}>
      <header className="top-bar">
        <span className="top-bar-side" />
        <h1 className="top-bar-title">{chat.title}</h1>
        <button type="button" className="icon-button" aria-label="שיחה חדשה" onClick={startNewChat}>
          <PlusIcon />
        </button>
      </header>

      <main className="scroll">
        {empty ? (
          <div className="opening">
            <div className="opening-text">
              <h2 className="greeting">{setup.childName ? `היי ${setup.childName}, על מה נדבר היום?` : 'היי, על מה נדבר היום?'}</h2>
              <p className="muted">אפשר לבחור מצב, או פשוט להתחיל לכתוב.</p>
            </div>
            <div className="mode-grid" role="group" aria-label="מצב">
              {MODES.map((m) => (
                <button key={m.id} type="button" className="mode-card" aria-pressed={m.id === mode} disabled={!isReady(m.id)} onClick={() => setMode(m.id)}>
                  <span className="mode-icon">
                    <ModeIcon mode={m.id} />
                  </span>
                  <span className="mode-name">{m.name}</span>
                  <span className="mode-description">{isReady(m.id) ? m.description : 'בקרוב'}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <Conversation messages={chat.messages} writing={writing} onRetry={retry} copyText={services.copyText} />
        )}

        <div className="notices" role="status">
          {blocked && <p className="notice">{SETUP_MESSAGE}</p>}
          {notice?.kind === 'limit' && <p className="notice">{LIMIT_MESSAGE}</p>}
          {error && (
            <div className="notice">
              <p>{error.text}</p>
              {error.retry && (
                <button type="button" className="small-button" onClick={retry}>
                  <RetryIcon />
                  <span>ננסה שוב</span>
                </button>
              )}
            </div>
          )}
          {notSaved && <p className="notice">{NOT_SAVED_MESSAGE}</p>}
          {empty && !blocked && !notSaved && <p className="muted bottom-note">השיחות נשמרות רק באייפון הזה</p>}
        </div>
      </main>

      <Composer mode={mode} writing={writing} blocked={blocked} onSend={send} onStop={stop} onPickMode={() => setPickingMode(true)} />
      </div>
      {pickingMode && <ModeSheet mode={mode} onPick={setMode} onClose={() => setPickingMode(false)} />}
    </div>
  );
}
