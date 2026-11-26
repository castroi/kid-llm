import { useEffect, useRef } from 'react';

/** How long after the app opens, or comes back to the screen, the cleanup of old files starts: after the first paint, never in the way. */
export const TRIM_DELAY_MS = 5_000;

/**
 * Starts the cleanup of old files (src/storage/trimFiles.ts) a little after the app opens and
 * each time it comes back to the screen (iOS brings a home-screen app back rather than opening
 * it again); the cleanup itself runs at most once a day. Never while an answer is being written,
 * never twice at once, and never on the chat on the screen.
 */
export function useFileTrim(run: ((skip: (chatId: string) => boolean) => Promise<unknown>) | undefined, chatId: string, writing: boolean, delayMs: number = TRIM_DELAY_MS): void {
  const current = useRef({ chatId, writing });
  useEffect(() => {
    current.current = { chatId, writing };
  }, [chatId, writing]);

  useEffect(() => {
    if (!run) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const start = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (running || current.current.writing || document.visibilityState === 'hidden') return;
        running = true;
        // Asked again before each chat: the chat she opens meanwhile, and every chat while an answer is being written, are left alone.
        run((id) => current.current.writing || id === current.current.chatId)
          .catch(() => undefined)
          .finally(() => {
            running = false;
          });
      }, delayMs);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') start();
    };
    start();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [run, delayMs]);
}
