import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MODES } from '../core/modes';
import { App } from './App';

describe('opening screen', () => {
  it('greets her and shows every mode by its name, never a model name', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'היי, על מה נדבר היום?' })).toBeInTheDocument();
    for (const mode of MODES) {
      expect(screen.getByRole('button', { name: new RegExp(mode.name) })).toBeInTheDocument();
    }
  });

  it('starts on plain chat, so she never has to choose before typing', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: /שיחה/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /חשבון/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches to the mode she taps', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: /חשבון/ }));
    expect(screen.getByRole('button', { name: /חשבון/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /שיחה/ })).toHaveAttribute('aria-pressed', 'false');
  });
});
