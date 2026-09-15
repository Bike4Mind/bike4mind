import type { Theme } from '@mui/joy/styles';

export const tooltipCustomizations = {
  JoyTooltip: {
    defaultProps: {
      arrow: true,
      modifiers: [
        {
          name: 'offset',
          options: {
            offset: [0, 10],
          },
        },
      ],
    },
    styleOverrides: {
      root: ({ theme }: { theme: Theme }) => ({
        backgroundColor: theme.palette.background.panel,
        border: '1px solid',
        borderColor: theme.palette.border.input,
        borderRadius: '6px',
        padding: '8px 12px',
        boxShadow: 'none',
        color: theme.palette.text.primary,
        fontSize: '12px',
        maxWidth: '400px',
      }),
      arrow: ({ theme }: { theme: Theme }) => ({
        '&::before': {
          backgroundColor: 'transparent',
          borderTopColor: theme.palette.border.input,
          borderRightColor: theme.palette.border.input,
        },
        // Remove the 0.5px offset for better alignment
        '[data-popper-placement*="top"] &': {
          bottom: 'calc(0px + var(--Tooltip-arrowSize) * -1 / 2)',
        },
        '[data-popper-placement*="bottom"] &': {
          top: 'calc(0px + var(--Tooltip-arrowSize) * -1 / 2)',
        },
        '[data-popper-placement*="left"] &': {
          right: 'calc(0px + var(--Tooltip-arrowSize) * -1 / 2)',
        },
        '[data-popper-placement*="right"] &': {
          left: 'calc(0px + var(--Tooltip-arrowSize) * -1 / 2)',
        },
      }),
    },
  },
};
