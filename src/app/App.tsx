import { useState } from 'react';
import { DEFAULT_MODE, MODES, type ModeId } from '../core/modes';
import { ModeIcon } from '../ui/icons';

/** The opening screen. The composer, the conversation and the history come in the next PRs. */
export function App() {
  const [mode, setMode] = useState<ModeId>(DEFAULT_MODE);

  return (
    <div className="screen">
      <header className="top-bar">
        <h1 className="top-bar-title">שיחה חדשה</h1>
      </header>
      <main className="opening">
        <div className="opening-text">
          <h2 className="greeting">היי, על מה נדבר היום?</h2>
          <p className="muted">אפשר לבחור מצב, או פשוט להתחיל לכתוב.</p>
        </div>
        <div className="mode-grid" role="group" aria-label="מצב">
          {MODES.map((m) => (
            <button key={m.id} type="button" className="mode-card" aria-pressed={m.id === mode} onClick={() => setMode(m.id)}>
              <span className="mode-icon">
                <ModeIcon mode={m.id} />
              </span>
              <span className="mode-name">{m.name}</span>
              <span className="mode-description">{m.description}</span>
            </button>
          ))}
        </div>
      </main>
      <footer className="bottom-note">
        <p className="muted">השיחות נשמרות רק באייפון הזה</p>
      </footer>
    </div>
  );
}
