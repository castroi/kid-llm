import { useCallback, useEffect, useRef, useState } from 'react';
import { isCommit } from '../core/update';

/** What the update check needs from outside, so tests can stand in for the site and the phone. */
export interface UpdateServices {
  /** The commit this build was made from. Anything but a full commit name turns the check off. */
  current: string;
  /** The commit the site serves now, or null when it can't tell (src/core/update.ts). */
  deployed: () => Promise<string | null>;
  /** Loads the newest version of the app. */
  reload: () => void;
  isOnline: () => boolean;
}

/**
 * How often an app left open asks whether a newer version is out. A web app on the iPhone's
 * home screen is often brought back rather than opened again, so it also asks each time it
 * comes back to the screen and when the phone is back online.
 */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface UpdateCheck {
  /** A newer version is out and the notice wasn't put off for it. */
  ready: boolean;
  /** Loads the newer version. */
  update: () => void;
  /** "אחר כך": the notice goes away until a version newer than this one is out. */
  later: () => void;
}

export function useUpdateCheck(updates: UpdateServices | undefined): UpdateCheck {
  const [newer, setNewer] = useState<string | null>(null);
  const [putOff, setPutOff] = useState<string | null>(null);
  const asking = useRef(false);

  const check = useCallback(() => {
    if (!updates || !isCommit(updates.current) || asking.current) return;
    if (document.visibilityState !== 'visible' || !updates.isOnline()) return;
    asking.current = true;
    void updates
      .deployed()
      .then((deployed) => {
        // A commit that differs from this build's is what the site serves now, newer or rolled back.
        if (deployed !== null && deployed !== updates.current) setNewer(deployed);
      })
      .finally(() => {
        asking.current = false;
      });
  }, [updates]);

  useEffect(() => {
    if (!updates || !isCommit(updates.current)) return;
    check();
    const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', check);
    };
  }, [updates, check]);

  const update = useCallback(() => updates?.reload(), [updates]);
  const later = useCallback(() => setPutOff(newer), [newer]);
  return { ready: newer !== null && newer !== putOff, update, later };
}
