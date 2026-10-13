import { extendTheme } from '@mui/joy/styles';

/**
 * Every tooltip's width cap. Joy leaves a tooltip to its content's width, so one long path or
 * sentence used to draw a single line off the right edge of the window.
 */
export const TOOLTIP_MAX_WIDTH = 340;

export const desktopTheme = extendTheme({
  components: {
    JoyTooltip: {
      styleOverrides: {
        root: {
          maxWidth: `min(${TOOLTIP_MAX_WIDTH}px, calc(100vw - 32px))`,
          // A path has no spaces to wrap at.
          overflowWrap: 'anywhere',
        },
      },
    },
  },
});
