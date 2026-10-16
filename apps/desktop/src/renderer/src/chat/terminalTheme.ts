import type { ITheme } from '@xterm/xterm';

/** VS Code's terminal ANSI colours, which are tuned for contrast on light and dark grounds. */
const ANSI: Record<'light' | 'dark', ITheme> = {
  light: {
    black: '#000000',
    red: '#cd3131',
    green: '#107c10',
    yellow: '#949800',
    blue: '#0451a5',
    magenta: '#bc05bc',
    cyan: '#0598bc',
    white: '#555555',
    brightBlack: '#666666',
    brightRed: '#cd3131',
    brightGreen: '#14ce14',
    brightYellow: '#b5ba00',
    brightBlue: '#0451a5',
    brightMagenta: '#bc05bc',
    brightCyan: '#0598bc',
    brightWhite: '#a5a5a5',
  },
  dark: {
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5',
  },
};

const FALLBACK = {
  light: { background: '#fbfcfe', foreground: '#171a1c', selection: '#c7dff7' },
  dark: { background: '#0b0d0e', foreground: '#f0f4f8', selection: '#0a2744' },
};

/**
 * The terminal's colours, from the Joy palette in force on `element`.
 *
 * Read from computed CSS variables rather than the theme object: Joy's palette entries are
 * `var(...)` references, and xterm draws with concrete colours. A custom property's computed
 * value has its references already substituted.
 */
export function xtermTheme(element: Element, mode: 'light' | 'dark'): ITheme {
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const fallback = FALLBACK[mode];
  const foreground = read('--joy-palette-text-primary', fallback.foreground);
  return {
    ...ANSI[mode],
    background: read('--joy-palette-background-surface', fallback.background),
    foreground,
    cursor: foreground,
    cursorAccent: read('--joy-palette-background-surface', fallback.background),
    selectionBackground: read('--joy-palette-primary-softActiveBg', fallback.selection),
  };
}
