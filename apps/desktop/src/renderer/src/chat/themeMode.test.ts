import { describe, expect, it } from 'vitest';
import { currentThemeMode, nextThemeMode, themeModeSummary } from './themeMode';

describe('cycling the appearance control', () => {
  it('reaches every state and returns to the start', () => {
    expect(nextThemeMode('system')).toBe('light');
    expect(nextThemeMode('light')).toBe('dark');
    expect(nextThemeMode('dark')).toBe('system');
  });

  /**
   * Joy hands back `undefined` until the provider has read localStorage, and a run of that
   * state must not strand the user: the first click has to land somewhere they can cycle out of.
   */
  it('treats an unread mode as following the system', () => {
    expect(currentThemeMode(undefined)).toBe('system');
    expect(nextThemeMode(undefined)).toBe('light');
  });

  it('ignores a stored value it does not recognise', () => {
    expect(currentThemeMode('sepia')).toBe('system');
    expect(nextThemeMode('sepia')).toBe('light');
  });
});

describe('the line under the label', () => {
  it('names the scheme the OS resolved to, but only while following it', () => {
    expect(themeModeSummary('system', 'dark')).toBe('System (dark)');
    expect(themeModeSummary('system', 'light')).toBe('System (light)');
  });

  it('names a picked scheme on its own', () => {
    expect(themeModeSummary('light', 'light')).toBe('Light');
    expect(themeModeSummary('dark', 'dark')).toBe('Dark');
  });

  // The resolved scheme lags the click by a paint, so a picked mode must not report it.
  it('does not let a stale resolved scheme contradict a picked one', () => {
    expect(themeModeSummary('dark', 'light')).toBe('Dark');
  });
});
