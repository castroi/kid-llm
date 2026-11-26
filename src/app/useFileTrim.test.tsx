import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRIM_DELAY_MS, useFileTrim } from './useFileTrim';

let visibility: DocumentVisibilityState = 'visible';
beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'visibilityState');
});

function comeBack() {
  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('starting the cleanup of old files', () => {
  it('starts a little after the app opens, skipping the chat on the screen', async () => {
    const run = vi.fn(async () => 0);
    renderHook(() => useFileTrim(run, 'shown-chat', false));
    await vi.advanceTimersByTimeAsync(TRIM_DELAY_MS - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledWith('shown-chat');
  });

  it('starts again each time the app comes back to the screen, with the chat shown then', async () => {
    const run = vi.fn(async () => 0);
    const { rerender } = renderHook(({ id }) => useFileTrim(run, id, false), { initialProps: { id: 'first' } });
    await vi.advanceTimersByTimeAsync(TRIM_DELAY_MS);
    rerender({ id: 'second' });
    comeBack();
    await vi.advanceTimersByTimeAsync(TRIM_DELAY_MS);
    expect(run.mock.calls).toEqual([['first'], ['second']]);
  });

  it('does not start while an answer is being written, off the screen, or while it still runs', async () => {
    let finish: () => void = () => undefined;
    const run = vi.fn(() => new Promise<number>((resolve) => (finish = () => resolve(0))));
    const { rerender } = renderHook(({ writing }) => useFileTrim(run, 'c', writing), { initialProps: { writing: true } });
    await vi.advanceTimersByTimeAsync(TRIM_DELAY_MS);
    expect(run).not.toHaveBeenCalled();

    rerender({ writing: false });
    visibility = 'hidden';
    comeBack();
    visibility = 'hidden';
    await vi.advanceTimersByTimeAsync(TRIM_DELAY_MS);
    expect(run).not.toHaveBeenCalled();

    comeBack();
    await vi.advanceTimersByTimeAsync(TRIM_DELAY_MS);
    expect(run).toHaveBeenCalledTimes(1);
    comeBack();
    await vi.advanceTimersByTimeAsync(TRIM_DELAY_MS);
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    comeBack();
    await vi.advanceTimersByTimeAsync(TRIM_DELAY_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does nothing where nothing is kept on the phone', async () => {
    renderHook(() => useFileTrim(undefined, 'c', false));
    await vi.advanceTimersByTimeAsync(TRIM_DELAY_MS * 2);
  });
});
