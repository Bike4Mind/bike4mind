// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DARK_PALETTE } from '../theme';
import { xtermTheme } from './terminalTheme';

describe('the terminal theme', () => {
  it('falls back to the dark palette when none of the CSS variables resolve', () => {
    const theme = xtermTheme(document.createElement('div'), 'dark');
    expect(theme.background).toBe(DARK_PALETTE.panel);
    expect(theme.foreground).toBe(DARK_PALETTE.ink);
    expect(theme.cursor).toBe(DARK_PALETTE.ink);
    expect(theme.selectionBackground).toBe(DARK_PALETTE.selected);
  });
});
