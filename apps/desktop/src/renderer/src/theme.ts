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

/**
 * Dark mode borrows the web app's cool, blue-tinted ramp instead of Joy's default, whose page is
 * pure black. Values are lifted from apps/client/app/utils/themes/colors.ts (`gray` / `brand`),
 * apart from the prompt-bubble fills; keep the lifted ones in step when the web ramp moves. Light
 * mode stays on Joy's defaults, which already share the web's light grays.
 */
export const DARK_PALETTE = {
  /** web gray[900]: the page behind the thread. */
  page: '#0E1214',
  /** web gray[850]: inputs, cards, the terminal. */
  panel: '#13181C',
  /** One step above panel: the sidebar and anything that floats (menus, popovers). */
  raised: '#181E23',
  /** web gray[800]: every border and divider, and the level2 fill (selected rows, inline code). */
  stroke: '#2C3135',
  /** web brand[100]: the pale-blue ink the web sets its text in. */
  ink: '#D1E4F4',
  /**
   * Pressed/selected (mode switcher, terminal selection). Deeper and bluer than the web's
   * brand[700] "selected" (#2A4159), which matched the level2 track it sits on in luminance
   * and vanished there.
   */
  selected: '#1B4B7A',
  /** web brand[900]: main button hover. */
  buttonHover: '#0959AA',
  /** The user's prompt bubble: a slate navy that reads as brand without glowing against the page. */
  bubble: '#172535',
  /** The same bubble under the pointer; pressed uses `selected`. */
  bubbleHover: '#1C3550',
} as const;

const INK_RGB = [1, 3, 5].map(offset => Number.parseInt(DARK_PALETTE.ink.slice(offset, offset + 2), 16)).join(' ');

// The web's secondary/tertiary ink steps (text.secondary / text.tertiary there); both clear 4.5:1
// on page, panel and raised.
const inkAt = (opacity: number) => `rgba(${INK_RGB} / ${opacity})`;

export const desktopTheme = extendTheme({
  colorSchemes: {
    dark: {
      palette: {
        // Joy derives surface/level1/level2 and the outlined border from these steps, so retinting
        // them carries the ramp into every component that never names a background.
        neutral: {
          700: DARK_PALETTE.stroke,
          800: DARK_PALETTE.raised,
          900: DARK_PALETTE.panel,
          // These default to neutral 800, which would vanish on the sidebar and on popups (level1
          // and popup are that same step).
          plainHoverBg: inkAt(0.06),
          outlinedHoverBg: inkAt(0.06),
          softBg: inkAt(0.08),
        },
        background: {
          body: DARK_PALETTE.page,
          surface: DARK_PALETTE.panel,
          popup: DARK_PALETTE.raised,
          level1: DARK_PALETTE.raised,
          level2: DARK_PALETTE.stroke,
        },
        divider: DARK_PALETTE.stroke,
        text: {
          primary: DARK_PALETTE.ink,
          secondary: inkAt(0.8),
          tertiary: inkAt(0.7),
        },
        primary: {
          // solidBg is already the web's main-button blue (#0B6BCB); only its hover differs.
          solidHoverBg: DARK_PALETTE.buttonHover,
          softBg: DARK_PALETTE.bubble,
          softHoverBg: DARK_PALETTE.bubbleHover,
          softActiveBg: DARK_PALETTE.selected,
          softColor: DARK_PALETTE.ink,
        },
      },
    },
  },
  components: {
    JoyMenu: {
      defaultProps: { modifiers: avoidPage },
    },
    JoyTooltip: {
      defaultProps: { modifiers: avoidPage },
      styleOverrides: {
        root: ({ theme, ownerState }) => ({
          maxWidth: `min(${TOOLTIP_MAX_WIDTH}px, calc(100vw - 32px))`,
          // A path has no spaces to wrap at.
          overflowWrap: 'anywhere',
          ...(ownerState.color === 'neutral' &&
            ownerState.variant === 'soft' && {
              backgroundColor: theme.vars.palette.background.popup,
            }),
        }),
        arrow: ({ theme, ownerState }) => ({
          ...(ownerState.color === 'neutral' &&
            ownerState.variant === 'soft' && {
              '&::before': {
                borderTopColor: theme.vars.palette.background.popup,
                borderRightColor: theme.vars.palette.background.popup,
              },
            }),
        }),
      },
    },
  },
});
