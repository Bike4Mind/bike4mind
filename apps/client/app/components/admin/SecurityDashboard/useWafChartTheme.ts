import { useTheme } from '@mui/joy';

// Joy UI exposes shadow/radius tokens on the theme at runtime but omits them from its public
// typings; this typed intersection accesses that undocumented shape without `any`.
type JoyThemeExtras = { shadow?: Record<string, string>; radius?: Record<string, string> };

/** Nivo chart theme for WAF visualizations, using Joy UI design tokens for axes, grid, and tooltips. */
export const useWafChartTheme = () => {
  const theme = useTheme();
  const themeExtras = theme as typeof theme & JoyThemeExtras;

  return {
    axis: {
      ticks: {
        text: {
          fill: theme.palette.text.primary,
          fontSize: 12,
        },
      },
      legend: {
        text: {
          fill: theme.palette.text.primary,
          fontSize: 12,
        },
      },
    },
    grid: {
      line: {
        stroke: theme.palette.divider,
      },
    },
    tooltip: {
      container: {
        background: theme.palette.background.surface,
        color: theme.palette.text.primary,
        boxShadow: themeExtras.shadow?.md ?? undefined,
        borderRadius: themeExtras.radius?.md ?? undefined,
      },
    },
  };
};
