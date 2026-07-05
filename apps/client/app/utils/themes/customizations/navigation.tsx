import { gray } from '../colors';
import type { Theme } from '@mui/joy/styles';

export const navigationCustomizations = {
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
