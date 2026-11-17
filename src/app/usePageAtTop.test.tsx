import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePageAtTop } from './usePageAtTop';

/*
 * On the iPhone the keyboard pushes the page up, and after a filtered list got shorter iOS
 * left it there once the keyboard closed: the parent area's top bar stayed under the status
 * bar, blurred by iOS 26. The page goes back to the top as soon as no field is typed in.
 */

let scrolledBy = 0;

beforeEach(() => {
  scrolledBy = 0;
  // jsdom never scrolls the page: say how far it is scrolled, as iOS would.
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrolledBy });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'scrollY');
  Reflect.deleteProperty(window, 'visualViewport');
});

function pageScrolled(by: number) {
  scrolledBy = by;
  window.dispatchEvent(new Event('scroll'));
}

function Fields() {
  usePageAtTop();
  return (
    <>
      <input aria-label="סינון לפי שם" type="text" />
      <input aria-label="תיבה" type="checkbox" />
      <button type="button">כפתור</button>
    </>
  );
}

describe('the page under the screens', () => {
  it('goes back to the top when it was scrolled and nothing is typed in', () => {
    renderHook(() => usePageAtTop());
    const scrollTo = vi.spyOn(window, 'scrollTo');
    pageScrolled(120);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('is left alone while it is at the top', () => {
    renderHook(() => usePageAtTop());
    const scrollTo = vi.spyOn(window, 'scrollTo');
    pageScrolled(0);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('stays where the keyboard put it while a field is typed in, and goes back once the field is left', () => {
    vi.useFakeTimers();
    const { getByLabelText, getByRole } = render(<Fields />);
    const scrollTo = vi.spyOn(window, 'scrollTo');

    const filter = getByLabelText('סינון לפי שם');
    act(() => filter.focus());
    pageScrolled(300);
    expect(scrollTo).not.toHaveBeenCalled();

    // The keyboard closes: the field loses its focus, here to a button.
    act(() => getByRole('button', { name: 'כפתור' }).focus());
    act(() => vi.runAllTimers());
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('a checkbox brings up no keyboard, so it does not keep the page scrolled', () => {
    const { getByLabelText } = render(<Fields />);
    const scrollTo = vi.spyOn(window, 'scrollTo');
    act(() => getByLabelText('תיבה').focus());
    pageScrolled(80);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('goes back to the top when the keyboard finishes closing', () => {
    const viewport = new EventTarget();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    renderHook(() => usePageAtTop());
    const scrollTo = vi.spyOn(window, 'scrollTo');
    scrolledBy = 200;
    viewport.dispatchEvent(new Event('resize'));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('stops listening when the app goes away', () => {
    const { unmount } = renderHook(() => usePageAtTop());
    unmount();
    const scrollTo = vi.spyOn(window, 'scrollTo');
    pageScrolled(150);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
