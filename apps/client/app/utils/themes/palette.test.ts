import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from './themePrimitives';

/**
 * Guards the palette-shape mismatch that lets a whole `sx` declaration disappear at runtime with
 * no error. Joy has no `main`/`light`/`dark`/`contrastText` key and no `error`/`info`/`secondary`/
 * `action` family, so `sx={{ color: 'primary.main' }}` resolves to nothing, the browser rejects the
 * leftover literal as a CSS value, and the declaration is dropped silently.
 *
 * The eslint guard in eslint.config.mjs catches the Material-shaped ones by regex. It cannot catch
 * a shade that simply does not exist (`primary.25`, `warning.550`) or a Joy key that was removed
 * between versions (`neutral.outlinedHoverBorder`) - only the theme knows those. So this resolves
 * every palette string the SPA actually contains against the built theme, rather than against a
 * hand-kept list that drifts.
 */
const theme = extendTheme({ ...getThemeConfig() });
const MODES = ['light', 'dark'] as const;
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// `common` is deliberately absent: this app's i18n keys are shaped the same way (`t('common.close')`)
// and there is no way to tell them apart from a palette lookup by shape alone.
const SCANNED_FAMILIES = ['primary', 'neutral', 'danger', 'success', 'warning', 'text', 'background'] as const;
const TOKEN_RE = new RegExp(`'((?:${SCANNED_FAMILIES.join('|')})\\.[A-Za-z0-9]+)'`, 'g');

const collectTokens = () => {
  const found = new Map<string, string>();
  for (const entry of fs.readdirSync(APP_DIR, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    // This file quotes dead tokens on purpose, to assert they are dead.
    if (file === fileURLToPath(import.meta.url)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const [, token] of source.matchAll(TOKEN_RE)) {
      if (!found.has(token)) found.set(token, path.relative(APP_DIR, file));
    }
  }
  return found;
};

const TOKENS_IN_SOURCE = collectTokens();

describe('Joy palette shape', () => {
  it('finds palette strings to check at all, so a broken scan cannot pass vacuously', () => {
    expect(TOKENS_IN_SOURCE.size).toBeGreaterThan(30);
    expect(TOKENS_IN_SOURCE.has('primary.plainColor')).toBe(true);
  });

  it.each(MODES)('%s: has no Material UI shade keys on any colour family', mode => {
    for (const family of ['primary', 'neutral', 'danger', 'success', 'warning'] as const) {
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

  it.each(MODES)('%s: every palette string in app/ resolves', mode => {
    const palette = theme.colorSchemes[mode].palette as Record<string, Record<string, unknown>>;
    const dead = [...TOKENS_IN_SOURCE]
      .filter(([token]) => {
        const [family, key] = token.split('.');
        return palette[family]?.[key] === undefined;
      })
      .map(([token, file]) => `${token} (${file})`);
    expect(dead).toEqual([]);
  });
});
