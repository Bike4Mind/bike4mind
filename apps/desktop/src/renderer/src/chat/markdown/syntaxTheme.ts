import type { CSSProperties } from 'react';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';

type PrismStyle = Record<string, CSSProperties>;

/**
 * Prism's own token colours, re-seated on the app's surface.
 *
 * Only the two container keys are rewritten. The token colours are what make a language
 * readable and they are left exactly as the theme ships them; the container is what decides
 * whether the block looks like part of this app or like a highlighter's idea of a page, so
 * its background, padding and margin are handed back to the Joy surface the block sits in.
 */
function seatOnSurface(base: PrismStyle): PrismStyle {
  const container: CSSProperties = {
    background: 'none',
    backgroundColor: 'transparent',
    margin: 0,
    padding: 0,
    fontFamily: 'var(--joy-fontFamily-code)',
    fontSize: 'var(--joy-fontSize-xs)',
    lineHeight: 1.6,
  };

  return {
    ...base,
    'code[class*="language-"]': { ...base['code[class*="language-"]'], ...container },
    'pre[class*="language-"]': { ...base['pre[class*="language-"]'], ...container },
  };
}

/**
 * Stable per mode, because a new object here would be a new `style` prop on every highlighted
 * block on every render, and the highlighter re-tokenizes when its style identity changes.
 */
export const SYNTAX_THEMES: Record<'light' | 'dark', PrismStyle> = {
  light: seatOnSurface(oneLight as PrismStyle),
  dark: seatOnSurface(oneDark as PrismStyle),
};
