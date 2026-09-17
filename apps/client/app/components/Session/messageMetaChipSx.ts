import type { Theme } from '@mui/joy';

/**
 * The metadata under a reply (credits, model, tools used). Same 24px height as the
 * action buttons across the footer from them, but no fill and no visible border:
 * these report what happened, they do not invite a click.
 *
 * The border stays 1px transparent rather than being removed, so the box keeps the
 * size it had and the row does not shift by a pixel per chip.
 */
export const messageMetaChipSx = (theme: Theme) => ({
  minHeight: '24px',
  height: '24px',
  px: '4px',
  gap: '4px',
  fontSize: '12px',
  fontWeight: 400,
  backgroundColor: 'transparent',
  border: '1px solid transparent',
  color: theme.vars.palette.text.tertiary,
});
