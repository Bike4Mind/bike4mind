import { describe, expect, it } from 'vitest';
import { extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from './themePrimitives';

/**
 * Guards the Material-UI-vs-Joy palette-shape mismatch that lets a whole `sx` declaration
 * disappear at runtime with no error: Joy has no `main`/`light`/`dark`/`contrastText` keys
 * and no `error`/`info`/`secondary`/`action` families, so `sx={{ color: 'primary.main' }}`
 * resolves to nothing, the browser rejects the literal, and the rule is dropped silently.
 *
 * The eslint `no-restricted-syntax` guard in eslint.config.mjs stops new ones being written;
 * this locks the theme half of the contract - that the tokens we replaced them with exist.
 */
const theme = extendTheme({ ...getThemeConfig() });
const MODES = ['light', 'dark'] as const;
const JOY_COLOR_FAMILIES = ['primary', 'neutral', 'danger', 'success', 'warning'] as const;

// Every palette token reachable from an `sx` string in apps/client/app. Keep in sync when a new
// one is introduced - a typo'd token fails here instead of silently rendering nothing.
const TOKENS_IN_USE: Record<(typeof JOY_COLOR_FAMILIES)[number], string[]> = {
  primary: ['500', 'plainColor', 'softColor', 'softBg', 'softHoverBg', 'solidBg', 'solidHoverBg'],
  neutral: ['plainColor', 'plainHoverBg', 'softBg', 'solidBg', 'outlinedBorder'],
  danger: ['plainColor', 'softColor', 'softBg', 'outlinedBorder'],
  success: ['plainColor', 'softColor', 'softBg', 'outlinedBorder'],
  warning: ['plainColor', 'softColor', 'softBg'],
};

describe('Joy palette shape', () => {
  it.each(MODES)('%s: has no Material UI shade keys on any colour family', mode => {
    for (const family of JOY_COLOR_FAMILIES) {
      const palette = theme.colorSchemes[mode].palette[family] as Record<string, unknown>;
      for (const key of ['main', 'light', 'dark', 'contrastText']) {
        expect(`${family}.${key}=${palette[key]}`).toBe(`${family}.${key}=undefined`);
      }
    }
  });

  it.each(MODES)('%s: has no Material-UI-only colour families', mode => {
    const palette = theme.colorSchemes[mode].palette as Record<string, unknown>;
    for (const family of ['error', 'info', 'secondary', 'action']) {
      expect(`${family}=${palette[family]}`).toBe(`${family}=undefined`);
    }
  });

  it.each(MODES)('%s: resolves every token the app uses', mode => {
    for (const [family, tokens] of Object.entries(TOKENS_IN_USE)) {
      const palette = theme.colorSchemes[mode].palette[family as (typeof JOY_COLOR_FAMILIES)[number]] as Record<
        string,
        unknown
      >;
      for (const token of tokens) {
        expect(`${family}.${token}=${typeof palette[token]}`).toBe(`${family}.${token}=string`);
      }
    }
  });
});
