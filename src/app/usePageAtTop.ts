import { useEffect } from 'react';

/** A field the keyboard is up for: while it is, iOS may push the page up to keep it in view. */
function typing(): boolean {
  const focused = document.activeElement;
  if (focused instanceof HTMLTextAreaElement || focused instanceof HTMLSelectElement) return true;
  return focused instanceof HTMLInputElement && !['checkbox', 'radio', 'file', 'button', 'submit'].includes(focused.type);
}

/**
 * The page itself never scrolls: everything that scrolls has its own box inside it. On the
 * iPhone the keyboard pushes the page up to keep a field in view, and when the page got
 * shorter while it was up (a filtered list), iOS doesn't always bring it back down once the
 * keyboard closes. The top bar then stays under the status bar, where iOS 26 blurs it, and
 * no drag can bring it back. So as soon as no field is being typed in, the page goes back
 * to the top.
 */
export function usePageAtTop() {
  useEffect(() => {
    const putBack = () => {
      if (!typing() && window.scrollY !== 0) window.scrollTo(0, 0);
    };
    // On focusout the field is still the focused element; the next one is known a moment later.
    let later: ReturnType<typeof setTimeout> | undefined;
    const afterFocusLeaves = () => {
      clearTimeout(later);
      later = setTimeout(putBack, 0);
    };
    window.addEventListener('scroll', putBack);
    document.addEventListener('focusout', afterFocusLeaves);
    // The keyboard finished closing.
    window.visualViewport?.addEventListener('resize', putBack);
    return () => {
      clearTimeout(later);
      window.removeEventListener('scroll', putBack);
      document.removeEventListener('focusout', afterFocusLeaves);
      window.visualViewport?.removeEventListener('resize', putBack);
    };
  }, []);
}
