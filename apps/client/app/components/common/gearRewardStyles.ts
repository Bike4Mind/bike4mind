import type { Theme } from '@mui/joy/styles';
import { grayAlpha, green, greenAlpha } from '@client/app/utils/themes/colors';

/**
 * The two chip styles gear rewards are drawn in, shared by the Gears page and
 * the sidenav's Gears row so the same state looks the same in both places.
 */

/**
 * The green of a claimable reward: the page's chip and claim line, and the
 * sidenav's `Claim N` tag.
 */
export const rewardGreen = (theme: Theme) => {
  // green[800] carries the dark surface at about 6:1, but the light one is near
  // white and drops it to 2.4:1 - the darker step of the same green clears AA
  // there. On the white card a solid stroke draws a hard box round the chip, so
  // light mode gets a tint instead - the same trick the theme's border.soft uses.
  const dark = theme.palette.mode === 'dark';
  // The fill steps down in dark mode, where the same 10% glows against the surface.
  // Hover and press each go one alpha step up from there.
  return {
    ink: dark ? green[800] : green[950],
    stroke: dark ? green[800] : greenAlpha[800][30],
    fill: dark ? greenAlpha[800][6] : greenAlpha[800][10],
    hoverFill: dark ? greenAlpha[800][10] : greenAlpha[800][15],
    activeFill: dark ? greenAlpha[800][15] : greenAlpha[800][20],
  };
};

/**
 * The neutral frame: the page's locked and claimed markers, and the sidenav's
 * `Start here` tag.
 */
export const neutralFrame = (theme: Theme) => ({
  backgroundColor: grayAlpha[150][10],
  border: `1px solid ${theme.palette.border.muted}`,
});
