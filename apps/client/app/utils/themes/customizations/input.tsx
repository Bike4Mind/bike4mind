import type { Theme } from '@mui/joy/styles';

export const inputCustomizations = {
  JoyButton: {
    styleOverrides: {
      root: ({ ownerState, theme }: { ownerState: any; theme: Theme }) => ({
        borderRadius: '8px',
        ...(ownerState.color === 'navItem' && {
          color: theme.palette.neutral.softColor,
          fontSize: '16px',
          fontWeight: 500,
        }),
        ...(ownerState.color === 'neutral' && {
          borderRadius: '6px',
          '--Icon-color': theme.palette.neutral.softColor,
        }),
        ...(ownerState.size === 'sm' && {
          '--Icon-fontSize': '1rem',
          '--Button-gap': '0.25rem',
          minHeight: 'var(--Button-minHeight, 1.75rem)',
          fontSize: theme.vars.fontSize.xs,
          paddingBlock: '2px',
          paddingInline: '0.5rem',
        }),
        ...(ownerState.size === 'xs' && {
          '--Icon-fontSize': '1rem',
          '--Button-gap': '0.25rem',
          minHeight: 'var(--Button-minHeight, 1.75rem)',
          fontSize: theme.vars.fontSize.xs,
          paddingBlock: '2px',
          paddingInline: '0.5rem',
        }),
        ...(ownerState.size === 'xl' && {
          '--Icon-fontSize': '2rem',
          '--Button-gap': '1rem',
          minHeight: 'var(--Button-minHeight, 4rem)',
          fontSize: theme.vars.fontSize.xl,
          paddingBlock: '0.5rem',
          paddingInline: '2rem',
        }),
      }),
    },
  },
  JoyIconButton: {
    styleOverrides: {
      root: ({ ownerState, theme }: { ownerState: any; theme: Theme }) => ({
        ...(ownerState.color === 'neutral' && {
          '--Icon-color': theme.palette.neutral.softColor,
        }),
      }),
    },
  },
  JoyInput: {
    styleOverrides: {
      root: {
        '--Input-radius': 'var(--joy-radius-md)',
      },
    },
  },
  JoySelect: {
    styleOverrides: {
      root: {
        '--Select-radius': '8px',
      },
    },
  },
};
