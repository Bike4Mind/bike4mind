import type { Theme } from '@mui/joy';

/**
 * The icon-button recipe every artifact card action uses - copy, save, open in viewer - and
 * the copy control on a fenced code block.
 *
 * It lives here rather than beside the cards because importing it from ArtifactPreviewCard
 * pulled that whole module (and its dependency graph) into the markdown renderer's, forming
 * a cycle that left the syntax theme undefined at evaluation time. Syntax highlighting went
 * flat app-wide, in components that had nothing to do with the change. A style constant
 * should not drag a component tree behind it.
 */
export const actionButtonSx = (theme: Theme) => ({
  // Joy sizes an IconButton from --IconButton-size; `width`/`height` alone lose to its
  // own minWidth/minHeight, so all three are needed to get off the 32px `sm` default.
  '--IconButton-size': '24px',
  minWidth: '24px',
  minHeight: '24px',
  '--Icon-fontSize': '16px',
  '--Icon-color': theme.vars.palette.text.primary70,
  '&:hover': {
    backgroundColor: theme.palette.notebooklist.hoverBg,
    '--Icon-color': theme.vars.palette.text.primary,
  },
});
