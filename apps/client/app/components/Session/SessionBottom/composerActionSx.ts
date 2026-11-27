import type { Theme } from '@mui/joy/styles';

/** Darkens the accent fill for hover/press without dimming the icon, spinner or focus ring. */
const shadeOfAccent = (theme: Theme, percent: number): string =>
  `color-mix(in srgb, ${theme.vars.palette.reading.accent} ${percent}%, black)`;

/**
 * Dark-mode fill for the composer's primary action slot (send, recording confirm, idle voice).
 * Joy's dark primary solidBg is its default blue, a second blue beside the accent, so these
 * buttons take the accent instead. Scoped to this slot rather than the theme so other solid
 * primary buttons keep their fill.
 *
 * Must stay in sync with the native sendButton role in
 * packages/design-tokens/src/emitters/native/nativeTheme.ts.
 */
export const composerActionDarkFill = (theme: Theme) => ({
  [theme.getColorSchemeSelector('dark')]: {
    // Outranks Joy's own hover/active rules, so both are restated here.
    '&:not(:disabled)': {
      bgcolor: 'reading.accent',
      '@media (hover: hover)': { '&:hover': { bgcolor: shadeOfAccent(theme, 88) } },
      '&:active': { bgcolor: shadeOfAccent(theme, 78) },
    },
  },
});
