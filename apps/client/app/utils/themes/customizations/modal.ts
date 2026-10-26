import type { Theme } from '@mui/joy/styles';

// ModalClose is an icon-only button; without a default every dialog's close control is unnamed.
// Lives here (not in themePrimitives) because AppTheme replaces baseConfig.components wholesale.
// A dialog's own `sx` still wins over these defaults, so dialogs that set their padding keep it.
// The What's New slider (components/modals/WhatsNewSliderModal.tsx) is the visual reference.
export const modalCustomizations = {
  JoyModalDialog: {
    styleOverrides: {
      root: ({ theme }: { theme: Theme }) => ({
        // Joy positions ModalClose from this variable.
        '--ModalClose-inset': '10px',
        backgroundColor: theme.palette.background.surface2,
        boxShadow: 'none',
        paddingTop: '32px',
        paddingBottom: '24px',
        paddingInline: '24px',
        [theme.breakpoints.down('sm')]: { paddingInline: '16px' },
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
