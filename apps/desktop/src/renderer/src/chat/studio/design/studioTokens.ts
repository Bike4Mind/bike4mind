import { studioColor, studioCssVariables, studioRadius, type StudioColorMode } from '@bike4mind/design-tokens';

export { studioColor, studioRadius };

// Desktop does not bundle Libre Franklin (see theme.ts), so Studio uses the system stack the rest of the app renders in.
const DESKTOP_STUDIO_FONTS = {
  ui: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

/** The `--studio-*` declarations for one mode, from the palette web Studio also renders with. */
export const desktopStudioVariables = (mode: StudioColorMode) => studioCssVariables(mode, DESKTOP_STUDIO_FONTS);

/** Web Studio's uppercase section label (STUDIO_MICRO_LABEL in apps/client Studio/design/studioTokens.ts). */
export const studioMicroLabelSx = {
  fontSize: '11px',
  fontWeight: 600,
  lineHeight: 1.2,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: studioColor('text-muted'),
} as const;

export const studioFocusSx = {
  '&:focus-visible': { outline: `2px solid ${studioColor('focus-ring')}`, outlineOffset: '2px' },
} as const;

export const studioPanelSx = {
  bgcolor: studioColor('surface'),
  border: `1px solid ${studioColor('hairline')}`,
  borderRadius: studioRadius('lg'),
} as const;

/** Web's 120ms colour and border easing, off under reduced motion. */
export const studioTransitionSx = {
  transition: 'background-color 120ms ease, border-color 120ms ease, color 120ms ease, box-shadow 120ms ease',
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
} as const;
