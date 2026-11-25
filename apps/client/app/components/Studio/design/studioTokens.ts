/**
 * Creative Studio design tokens for web. The palette and radii live in @bike4mind/design-tokens so
 * Desktop's Studio renders from the same source; this module adds web's fonts and the shared style
 * fragments. StudioThemeScope declares them as `--studio-*` CSS variables, so nothing outside a Studio
 * route can read them.
 */
import {
  studioColor,
  studioCssVariables as studioCssVariablesWithFonts,
  studioFont,
  type StudioColorMode,
} from '@bike4mind/design-tokens';

export {
  STUDIO_PALETTES,
  STUDIO_RADII,
  studioColor,
  studioFont,
  studioRadius,
  type StudioColorMode,
  type StudioColorRole,
  type StudioRadius,
} from '@bike4mind/design-tokens';

// Both faces are already loaded app-wide by next/font in app/layout.tsx; Libre Franklin is the html font.
export const STUDIO_FONTS = {
  ui: 'var(--font-reading-sans), "Libre Franklin", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mono: 'var(--font-reading-mono), "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

/** Every `--studio-*` declaration for one mode; StudioThemeScope applies it to its root. */
export const studioCssVariables = (mode: StudioColorMode): Record<string, string> =>
  studioCssVariablesWithFonts(mode, STUDIO_FONTS);

/** The uppercase, letter-spaced micro-label the mock uses for every section head. */
export const STUDIO_MICRO_LABEL = {
  fontFamily: studioFont('ui'),
  fontSize: '11px',
  fontWeight: 600,
  lineHeight: 1.2,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: studioColor('text-muted'),
} as const;

/** The focus ring every interactive Studio primitive shares. */
export const STUDIO_FOCUS_VISIBLE = {
  outline: `2px solid ${studioColor('focus-ring')}`,
  outlineOffset: '2px',
} as const;
