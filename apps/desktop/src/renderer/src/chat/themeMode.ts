/**
 * The three states the appearance control moves between, in the order it cycles them.
 *
 * 'system' is first because it is what the app has always done, and dropping it would make
 * following the OS unreachable once a user had picked either of the other two.
 */
export const THEME_MODES = ['system', 'light', 'dark'] as const;

export type ThemeMode = (typeof THEME_MODES)[number];

/** Whichever scheme is actually painted - 'system' has already been resolved to one of these. */
export type ResolvedThemeMode = 'light' | 'dark';

/**
 * Joy reports no mode at all until the provider has read its stored value, so an unknown mode
 * is normal on the first render rather than a fault, and is treated as 'system'.
 */
export function currentThemeMode(mode: string | undefined): ThemeMode {
  return (THEME_MODES as readonly string[]).includes(mode ?? '') ? (mode as ThemeMode) : 'system';
}

export function nextThemeMode(mode: string | undefined): ThemeMode {
  const index = THEME_MODES.indexOf(currentThemeMode(mode));
  return THEME_MODES[(index + 1) % THEME_MODES.length];
}

/**
 * One line naming the choice, and - when the choice is 'system' - what it currently resolves
 * to. Following the OS is otherwise indistinguishable from having picked whatever the OS
 * happens to be set to, which is the question the row exists to answer.
 *
 * `resolved` must come from `useTheme().palette.mode`, never from `useColorScheme().mode`:
 * that one can be the string 'system', which is not a scheme.
 */
export function themeModeSummary(mode: string | undefined, resolved: ResolvedThemeMode): string {
  switch (currentThemeMode(mode)) {
    case 'light':
      return 'Light';
    case 'dark':
      return 'Dark';
    default:
      return `System (${resolved})`;
  }
}
