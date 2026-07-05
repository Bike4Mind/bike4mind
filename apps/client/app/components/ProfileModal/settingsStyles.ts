import { alpha } from '@mui/system';
import type { Theme } from '@mui/joy/styles';

// Shared design tokens for the Profile / Settings surface, so every panel reads
// as one control surface: a single card skin, one hairline border for both color
// modes, and a fixed typographic scale.
//
// Usage: spread the surface helpers inside an sx theme-callback so a card can
// add its own layout on top, e.g.
//   sx={theme => ({ ...cardSurfaceSx(theme), display: 'flex', gap: '12px' })}

/** Card/control-surface fill, used by every inner settings card. */
export const surfaceBg = (theme: Theme) => (theme.palette.mode === 'light' ? '#FFFFFF' : theme.palette.background.body);

/** The one hairline border token, identical in both modes (light uses a cool
 *  gray, dark uses the theme's `border.light`). */
export const hairlineBorderColor = (theme: Theme) =>
  theme.palette.mode === 'light' ? 'rgba(190, 209, 223, 0.7)' : 'border.light';

/** Muted body text - descriptions, helper copy. */
export const mutedTextColor = (theme: Theme) =>
  theme.palette.mode === 'dark' ? alpha(theme.palette.text.primary, 0.5) : alpha(theme.palette.text.primary, 0.7);

/** Muted table-header cell style, shared across every Profile/Settings `<Table>`.
 *  Spread into a `'& thead th'` sx rule; callers that need it add `whiteSpace`. */
export const tableHeaderSx = {
  fontSize: '14px',
  color: 'text.primary',
  opacity: 0.5,
  fontWeight: 500,
  backgroundColor: 'transparent',
} as const;

/** Standard inner card skin (fill + hairline border + radius + padding).
 *  Callers add their own `display`/`gap`/`flex` layout. */
export const cardSurfaceSx = (theme: Theme) => ({
  backgroundColor: surfaceBg(theme),
  border: '1px solid',
  borderColor: hairlineBorderColor(theme),
  borderRadius: '8px',
  p: '16px',
});

/** The outer section panel skin (the `SectionContainer` wrapper). */
export const panelSurfaceSx = (theme: Theme) => ({
  backgroundColor: 'primary.softBg',
  borderRadius: '10px',
  padding: '24px',
  border: '1px solid',
  borderColor: hairlineBorderColor(theme),
});

/** Typographic scale - Joy `level` values so spacing/weight come from the
 *  theme instead of scattered `fontSize` literals. */
export const TYPE = {
  sectionTitle: 'title-md',
  cardTitle: 'title-sm',
  body: 'body-sm',
  caption: 'body-xs',
  statValue: 'title-lg',
} as const;
