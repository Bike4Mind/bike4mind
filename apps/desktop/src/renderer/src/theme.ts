import { extendTheme } from '@mui/joy/styles';
import { avoidPageModifier } from './chat/agentBrowser';

/**
 * Every tooltip's width cap. Joy leaves a tooltip to its content's width, so one long path or
 * sentence used to draw a single line off the right edge of the window.
 */
export const TOOLTIP_MAX_WIDTH = 340;

/**
 * Every tooltip and menu slides off the agent's browser page, which is a native view drawn above
 * them; see agentBrowser.ts. A call site passing its own `modifiers` replaces this, so one that
 * needs both has to include it.
 */
const avoidPage = [avoidPageModifier];

export const desktopTheme = extendTheme({
  components: {
    JoyMenu: {
      defaultProps: { modifiers: avoidPage },
    },
    JoyTooltip: {
      defaultProps: { modifiers: avoidPage },
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
