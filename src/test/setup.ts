import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no page to scroll: its window.scrollTo only prints "not implemented".
window.scrollTo = () => undefined;

afterEach(() => {
  cleanup();
});
