import { useState, type ReactNode } from 'react';
import { filterModels, modelsFor, priceText, type ModelField as Field, type ModelInfo } from '../ai/models';

/** A phone screen holds a short list; typing narrows it. */
export const MAX_SHOWN_MODELS = 40;

/** What the provider says about a model: privacy, uncensored, TEE, E2EE, and the price for a million tokens. */
function ModelTags({ model }: { model: ModelInfo }) {
  return (
    <span className="model-tags">
      {model.privacy === 'private' && <span className="tag">Private</span>}
      {model.privacy === 'anonymized' && <span className="tag">Anonymized</span>}
      {model.uncensored && <span className="tag alert">Uncensored</span>}
      {model.tee && <span className="tag">TEE</span>}
      {model.e2ee && <span className="tag">E2EE</span>}
      {model.price && <span className="model-price">{priceText(model.price)}</span>}
    </span>
  );
}

export interface ModelFieldProps {
  id: string;
  label: string;
  /** Which models fit: a mode, or the model for attached files. */
  field: Field;
  value: string;
  maxLength: number;
  onChange: (value: string) => void;
  /** The provider's list; null while there is none, and then the name is typed by hand. */
  models: readonly ModelInfo[] | null;
  /** A parent's own use: uncensored models are offered too. */
  parentUse: boolean;
  /** The chosen model is uncensored while the app is set for a child: it will not answer her. */
  blocked: boolean;
  /** Set for a child, and the provider's list doesn't know this name: it can't be checked for being uncensored. */
  unchecked: boolean;
  children?: ReactNode;
}

/**
 * One model of the parent's settings: the name can always be typed, and once the provider's
 * list is loaded it can be picked from the list, narrowed by typing part of a name. Names
 * and tags come from the provider and are shown as plain text, left to right.
 */
export function ModelField({ id, label, field, value, maxLength, onChange, models, parentUse, blocked, unchecked, children }: ModelFieldProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const chosen = models?.find((model) => model.id === value.trim());
  const matching = models && open ? filterModels(modelsFor(field, models, parentUse), typed) : [];

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input"
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        dir="ltr"
        maxLength={maxLength}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {chosen && (
        <p className="model-chosen" dir="ltr">
          <span className="model-name">{chosen.name}</span>
          <ModelTags model={chosen} />
        </p>
      )}
      {blocked && (
        <p className="hint warning">
          מודל לא מצונזר: הוא עונה רק כשהתיבה "האפליקציה בשימוש של ילדה" לא מסומנת. כל עוד היא מסומנת, {field === 'files' ? 'היא לא יכולה לצרף קבצים' : 'המצב הזה לא זמין לה'}.
        </p>
      )}
      {unchecked && <p className="hint warning">השם הזה לא מופיע ברשימת המודלים של הספק, ולכן אי אפשר לבדוק אם המודל לא מצונזר. כדאי לבחור מהרשימה.</p>}
      {models && (
        <>
          <button type="button" className="button" aria-expanded={open} aria-label={`${label}: בחירה מהרשימה`} onClick={() => setOpen((was) => !was)}>
            {open ? 'סגירת הרשימה' : 'בחירה מהרשימה'}
          </button>
          {open && (
            <div className="model-picker">
              <input
                className="input"
                type="text"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                dir="ltr"
                maxLength={maxLength}
                aria-label={`${label}: סינון לפי שם`}
                placeholder="סינון לפי שם"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
              {matching.length === 0 ? (
                <p className="hint">אין מודל מתאים.</p>
              ) : (
                <ul className="model-list">
                  {matching.slice(0, MAX_SHOWN_MODELS).map((model) => (
                    <li key={model.id}>
                      <button
                        type="button"
                        className="model-option"
                        dir="ltr"
                        onClick={() => {
                          onChange(model.id);
                          setOpen(false);
                          setTyped('');
                        }}
                      >
                        <span className="model-name">{model.name}</span>
                        <span className="model-id">{model.id}</span>
                        <ModelTags model={model} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {matching.length > MAX_SHOWN_MODELS && (
                <p className="hint">
                  מוצגים {MAX_SHOWN_MODELS} מתוך {matching.length}. הקלדה מצמצמת את הרשימה.
                </p>
              )}
            </div>
          )}
        </>
      )}
      {children}
    </div>
  );
}
