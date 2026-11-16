import type { Theme } from '@mui/joy/styles';

// ModalClose is an icon-only button; without a default every dialog's close control is unnamed.
// Lives here (not in themePrimitives) because AppTheme replaces baseConfig.components wholesale.
// A dialog's own `sx` still wins over these defaults, so dialogs that set their padding keep it.
// The What's New slider (components/modals/WhatsNewSliderModal.tsx) is the visual reference.
export const modalCustomizations = {
  JoyModalDialog: {
    styleOverrides: {
      root: ({ theme, ownerState }: { theme: Theme; ownerState: { size?: string; layout?: string } }) => ({
        // Joy positions ModalClose from this variable.
        '--ModalClose-inset': '10px',
        backgroundColor: theme.palette.background.surface2,
        boxShadow: 'none',
        // Padding goes through Joy's --Card-padding so Divider/CardOverflow bleed and a dialog's own `p` keep working.
        // Explicit sizes and fullscreen dialogs keep Joy's own sizing.
        ...(ownerState.size === 'md' &&
          ownerState.layout !== 'fullscreen' && {
            '--Card-padding': '24px',
            [theme.breakpoints.down('sm')]: { '--Card-padding': '16px' },
            paddingTop: '32px',
          }),
      }),
    },
  },
  JoyModalClose: {
    defaultProps: {
      'aria-label': 'Close',
    },
    styleOverrides: {
      root: ({ theme }: { theme: Theme }) => ({
        '--Icon-color': theme.palette.text.tertiary,
        '&:hover': {
          backgroundColor: 'transparent',
          '--Icon-color': theme.palette.text.primary,
        },
      }),
    },
  },
};
