import { useCallback, useEffect, useRef, useState } from 'react';
import { canAttachIn } from '../core/attachment';
import { kidMessage, LIMIT_MESSAGE, NOT_SAVED_MESSAGE, PARENT_USE_MESSAGE, SETUP_MESSAGE, UPDATE_MESSAGE } from '../core/kidMessages';
import { isReady, MODES, type ModeId } from '../core/modes';
import { fileModelFor, missingFor, modelFor } from '../storage/settings';
import { Composer } from '../ui/Composer';
import { Conversation } from '../ui/Conversation';
import { HistoryDrawer } from '../ui/HistoryDrawer';
import { MenuIcon, ModeIcon, PlusIcon, RetryIcon } from '../ui/icons';
import { ModeSheet } from '../ui/ModeSheet';
import { ParentArea } from '../ui/ParentArea';
import type { ParentServices } from './parentServices';
import { useChat, type Services } from './useChat';
import { useUpdateCheck, type UpdateServices } from './useUpdateCheck';

/** The chat screen: the opening with the modes, then the conversation, with the composer below. */
/** What the screen needs to know about the setup: her name, which modes are ready and the model behind each, never the key itself. */
function readSetup(services: Services) {
  const settings = services.loadSettings();
  const apiKey = services.loadApiKey(settings.provider);
  const notSetUp = MODES.filter((m) => missingFor(m.id, settings, apiKey) !== null).map((m) => m.id);
  // The model each mode would be answered by now: none for an uncensored model while a child uses the app.
  const models = Object.fromEntries(MODES.map((m) => [m.id, modelFor(m.id, settings)])) as Record<ModeId, string>;
  // She can attach a file only once the parent chose a model for files.
  return { models, childName: settings.childName, notSetUp: notSetUp as readonly ModeId[], filesReady: apiKey !== '' && fileModelFor(settings) !== '', parentUse: settings.parentUse === true };
}

export function App({ services, parent, updates }: { services: Services; parent: ParentServices; updates?: UpdateServices }) {
  const { chat, mode, writing, notice, notSaved, setMode, send, stop, retry, startNewChat, listChats, openChat, renameChat } = useChat(services);
  const newVersion = useUpdateCheck(updates);
  // She has started a message: loading the new version now would throw it away.
  const [drafting, setDrafting] = useState(false);
  const [inHistory, setInHistory] = useState(false);
  const [pickingMode, setPickingMode] = useState(false);
  const [inParentArea, setInParentArea] = useState(false);
  // Read when the app opens and again when the parent area closes; every send reads the
  // settings itself, so a change takes effect at once.
  const [setup, setSetup] = useState(() => readSetup(services));
  // Whose hands the app is in, as the screen last knew it.
  const parentUse = useRef(setup.parentUse);
  const refreshSetup = useCallback(() => {
    const next = readSetup(services);
    // The app changed hands (her use, or a parent's own): the chat on the screen is not carried
    // over. She doesn't get a parent's chat to read or continue, and a parent starts a new one.
    if (next.parentUse !== parentUse.current) {
      parentUse.current = next.parentUse;
      startNewChat();
    }
    setSetup(next);
  }, [services, startNewChat]);
  const closeParentArea = useCallback(() => {
    refreshSetup();
    setInParentArea(false);
  }, [refreshSetup]);
  // The settings can also change outside this screen (another tab of the site): read them again
  // when that happens and whenever the app comes back to the screen, so the notice never goes stale.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshSetup();
    };
    window.addEventListener('storage', refreshSetup);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('storage', refreshSetup);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshSetup]);

  const blocked = setup.notSetUp.includes(mode);
  const empty = chat.messages.length === 0;
  const error = notice?.kind === 'error' ? kidMessage(notice.reason) : null;

  if (inParentArea) {
    return (
      <div className="screen">
        <ParentArea parent={parent} onClose={closeParentArea} onChatsDeleted={startNewChat} />
      </div>
    );
  }

  return (
    <div className="screen">
      {/* While the mode picker or the list of chats is open, nothing behind it can be reached. */}
      <div className="screen-content" inert={pickingMode || inHistory}>
      <header className="top-bar">
        <button type="button" className="icon-button" aria-label="השיחות שלי" onClick={() => setInHistory(true)}>
          <MenuIcon />
        </button>
        <h1 className="top-bar-title">{chat.title}</h1>
        <button type="button" className="icon-button" aria-label="שיחה חדשה" onClick={startNewChat}>
          <PlusIcon />
        </button>
      </header>
      {/* For as long as the child instructions are off, the chat screen says so: a phone handed back to her like this is noticed. */}
      {setup.parentUse && (
        <p className="parent-use" role="note">
          {PARENT_USE_MESSAGE}
        </p>
      )}
      {/* Loading the new version reloads the app, so never while that would lose something: an
          answer being written, a message she started, or a chat the phone couldn't save. */}
      {newVersion.ready && !writing && !drafting && !notSaved && (
        <div className="update-notice" role="status">
          <p>{UPDATE_MESSAGE}</p>
          <div className="update-actions">
            <button type="button" className="small-button update-now" onClick={newVersion.update}>
              לעדכן
            </button>
            <button type="button" className="small-button" onClick={newVersion.later}>
              אחר כך
            </button>
          </div>
        </div>
      )}

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
          <Conversation messages={chat.messages} writing={writing} onRetry={retry} copyText={services.copyText} links={setup.parentUse} />
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

      <Composer
        mode={mode}
        model={setup.models[mode]}
        writing={writing}
        blocked={blocked}
        attach={setup.filesReady && !blocked && canAttachIn(mode) ? services.prepareAttachment : null}
        onSend={send}
        onStop={stop}
        onPickMode={() => setPickingMode(true)}
        onDraftChange={setDrafting}
      />
      </div>
      {pickingMode && <ModeSheet mode={mode} models={setup.models} onPick={setMode} onClose={() => setPickingMode(false)} />}
      {inHistory && (
        <HistoryDrawer
          currentId={chat.id}
          saved={services.store !== null}
          now={services.now}
          list={listChats}
          onOpen={openChat}
          onRename={renameChat}
          onNew={startNewChat}
          onParentArea={() => setInParentArea(true)}
          onClose={() => setInHistory(false)}
        />
      )}
    </div>
  );
}
