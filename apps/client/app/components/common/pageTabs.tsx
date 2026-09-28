import { Tab } from '@mui/joy';
import { styled } from '@mui/system';
import { profileTabListSx } from '@client/app/routes/profile/profileTabListSx';

/**
 * The /profile tab strip, for the full-page surfaces that sit in a PageFrame
 * (Gears), plus one fix those pages need.
 *
 * Joy derives a child radius from `--List-radius` and applies it to the items
 * marked data-first-child / data-last-child, which rounds the OUTER corners of
 * the whole strip - the TabList root itself also paints `var(--List-radius)`.
 * Squaring the tabs alone cannot reach either, so zero the variable instead.
 */
export const pageTabListSx = {
  ...profileTabListSx,
  '--List-radius': '0px',
  // Tabs is a flex column, so the strip is a flex item and would shrink below its
  // own height on a short frame. profileTabListSx only pins the tabs INSIDE the
  // strip (the horizontal axis); this pins the strip itself.
  flexShrink: 0,
} as const;

/** StyledTab from /profile, minus its icon rules (these tabs are text only). */
export const PageTab = styled(Tab)(({ theme }) => ({
  borderBottomLeftRadius: '0',
  borderBottomRightRadius: '0',
  '&:hover:not([aria-selected="true"])': {
    backgroundColor: `${theme.palette.notebooklist.hoverBg} !important`,
    '& .MuiTypography-root': {
      opacity: 1,
    },
  },
  '& .MuiTypography-root': {
    opacity: 0.7,
  },
  '&[aria-selected="true"] .MuiTypography-root': {
    opacity: 1,
  },
}));
