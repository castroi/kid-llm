import { useEffect, useRef } from 'react';
import { isReady, MODES, type ModeId } from '../core/modes';
import { CheckIcon, ModeIcon } from './icons';

export interface ModeSheetProps {
  mode: ModeId;
  /** The model behind each mode, shown under the mode; empty for a mode that has none. */
  models: Readonly<Record<ModeId, string>>;
  onPick: (mode: ModeId) => void;
  onClose: () => void;
}

/** The mode picker that slides up from the composer's chip. Each mode is shown with the model behind it. */
export function ModeSheet({ mode, models, onPick, onClose }: ModeSheetProps) {
  const sheet = useRef<HTMLElement>(null);

  // Focus goes into the sheet when it opens and back to where it was when it closes.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (sheet.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? sheet.current)?.focus();
    return () => before?.focus();
  }, []);

  return (
    <div
      className="sheet-layer"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <button type="button" className="scrim" aria-label="סגירה" onClick={onClose} />
      <section ref={sheet} className="sheet" role="dialog" aria-modal="true" aria-labelledby="mode-sheet-title" tabIndex={-1}>
        <h2 id="mode-sheet-title" className="sheet-title">
          במה להשתמש עכשיו?
        </h2>
        <div className="sheet-list">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className="sheet-row"
              aria-pressed={m.id === mode}
              disabled={!isReady(m.id)}
              onClick={() => {
                onPick(m.id);
                onClose();
              }}
            >
              <span className="mode-icon">
                <ModeIcon mode={m.id} />
              </span>
              <span className="sheet-row-text">
                <span className="mode-name">{m.name}</span>
                <span className="mode-description">{isReady(m.id) ? m.description : 'בקרוב'}</span>
                {models[m.id] && (
                  <bdi dir="ltr" className="mode-model">
                    {models[m.id]}
                  </bdi>
                )}
              </span>
              {m.id === mode && (
                <span className="sheet-check">
                  <CheckIcon />
                </span>
              )}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
