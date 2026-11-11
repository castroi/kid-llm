import { isReady, MODES, type ModeId } from '../core/modes';
import { CheckIcon, ModeIcon } from './icons';

export interface ModeSheetProps {
  mode: ModeId;
  onPick: (mode: ModeId) => void;
  onClose: () => void;
}

/** The mode picker that slides up from the composer's chip. She sees modes, never model names. */
export function ModeSheet({ mode, onPick, onClose }: ModeSheetProps) {
  return (
    <div className="sheet-layer">
      <button type="button" className="scrim" aria-label="סגירה" onClick={onClose} />
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="mode-sheet-title">
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
