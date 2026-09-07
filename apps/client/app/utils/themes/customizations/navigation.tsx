import { gray } from '../colors';
import type { Theme } from '@mui/joy/styles';

export const navigationCustomizations = {
  /**
   * A collapsed AccordionDetails is clipped to a zero-height grid row, but its children
   * keep their full boxes and stay hit-testable, so they intercept clicks aimed at
   * whatever renders below them - typically the next section's header. Joy already sets
   * the native `hidden` attribute on a collapsed panel, but its own `display: grid`
   * overrides the user-agent `[hidden] { display: none }` rule, so the attribute has no
   * effect. Honour it with `visibility` rather than `display` so the panel stays
   * animatable if an AccordionGroup is ever given a `transition`.
   */
  JoyAccordionDetails: {
    styleOverrides: {
      root: {
        '&[hidden]': {
          visibility: 'hidden' as const,
        },
      },
    },
  },
  JoyMenu: {
    styleOverrides: {
      root: ({ theme }: { theme: Theme }) => {
        const { mode } = theme.palette;
        return {
          '&.menuSurface': {
            background: mode === 'dark' ? gray[900] : gray[25],
            border: `1px solid ${mode === 'dark' ? gray[800] : gray[200]}`,
          },
        };
      },
    },
  },
  JoyTab: {
    styleOverrides: {
      root: {
        borderRadius: '6px 6px 0 0',
      },
    },
    defaultProps: {
      disableIndicator: true,
    },
  },
  JoyTabs: {
    styleOverrides: {
      root: {
        backgroundColor: 'transparent',
      },
    },
  },
  JoyTabPanel: {
    styleOverrides: {
      root: {
        padding: 0,
      },
    },
  },
};
