import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no page to scroll: its window.scrollTo only prints "not implemented".
// Some test files run in node, with no window at all.
if (typeof window !== 'undefined') window.scrollTo = () => undefined;

afterEach(() => {
  cleanup();
});
