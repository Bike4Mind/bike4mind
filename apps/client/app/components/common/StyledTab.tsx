import { styled } from '@mui/joy/styles';
import Tab from '@mui/joy/Tab';

/**
 * The app's tab: an unselected tab sits back in text.tertiary and comes forward to
 * text.primary when selected or hovered, with the hover tint the rest of the chrome uses.
 * Radius, the hidden indicator and the transparent Tabs background all arrive from the theme
 * (themes/customizations/navigation.tsx), so they are not repeated here.
 *
 * Named ink rather than the opacity the profile page's own copy still uses. Opacity fades a
 * tab toward whatever it sits on, so the same rule lands on a different colour per surface;
 * the text tokens are the recession the rest of the app is built from.
 *
 * Shared because this block was being hand-copied per surface - `/profile`, the tutorials
 * explorer and the profile sub-tabs each carry their own near-identical version, and the
 * sub-tabs copy had already drifted (it lost the flat bottom corners). Pair it with
 * `profileTabListSx` on the TabList.
 *
 * The colour rules target Typography and SvgIcon rather than the tab itself, so a label
 * passed as a bare string gets no selected/unselected distinction at all: wrap tab labels
 * in a Typography.
 */
export const StyledTab = styled(Tab)(({ theme }) => ({
  borderBottomLeftRadius: '0',
  borderBottomRightRadius: '0',
  '&:hover:not([aria-selected="true"])': {
    backgroundColor: `${theme.palette.notebooklist.hoverBg} !important`,
    '& .MuiTypography-root': { color: theme.vars.palette.text.primary },
    '& .MuiSvgIcon-root': { color: theme.vars.palette.text.primary },
  },
  '& .MuiTypography-root': { color: theme.vars.palette.text.tertiary },
  '& .MuiSvgIcon-root': { color: theme.vars.palette.text.tertiary },
  '&[aria-selected="true"] .MuiTypography-root': { color: theme.vars.palette.text.primary },
  '&[aria-selected="true"] .MuiSvgIcon-root': { color: theme.vars.palette.text.primary },
}));

export default StyledTab;
