import { Tab } from '@mui/joy';
import { styled } from '@mui/system';
import { profileTabListSx } from '@client/app/components/common/profileTabListSx';

/**
 * The page-level tab strip: /profile and the full-page surfaces that sit in a
 * PageFrame (Gears), plus one fix those framed pages need.
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
  // /profile stacks each tab's icon over its label on a phone. These tabs have no
  // icon, only a label and maybe a count, which should stay beside it.
  '& .MuiTab-root': { ...profileTabListSx['& .MuiTab-root'], flexDirection: 'row' },
} as const;

/**
 * The page-level tab, shared by /profile and Gears. An unselected tab recedes by
 * opacity: 0.7 on its label and 0.5 on its icon, back to full when hovered or selected.
 *
 * Kept apart from components/common/StyledTab, which recedes by colour (text.tertiary)
 * instead: side by side on Gears that read too dim for tabs that head a whole page.
 * Opacity fades everything inside the label, so anything that must stay at full
 * strength on an unselected tab (the Gears claim counts) is a Box, not a Typography.
 */
export const PageTab = styled(Tab)(({ theme }) => ({
  borderBottomLeftRadius: '0',
  borderBottomRightRadius: '0',
  '&:hover:not([aria-selected="true"])': {
    backgroundColor: `${theme.palette.notebooklist.hoverBg} !important`,
    '& .MuiTypography-root': { opacity: 1 },
    '& .MuiSvgIcon-root': { opacity: 1 },
  },
  '& .MuiTypography-root': { opacity: 0.7 },
  '& .MuiSvgIcon-root': { opacity: 0.5 },
  '&[aria-selected="true"] .MuiTypography-root': { opacity: 1 },
  '&[aria-selected="true"] .MuiSvgIcon-root': { opacity: 1 },
}));
