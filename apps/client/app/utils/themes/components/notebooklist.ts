import { grayAlpha, brandAlpha } from '../colors';

// Custom values with unique opacity not in theme defaults.
// Selected (focusedBackground) matches hover so both share one highlight color:
// #2A2C38 @ 70% (grayAlpha[775][70]) in dark, the light-blue tint in light mode.
export const notebooklistTheme = {
  dark: {
    hoverBg: grayAlpha[775][70],
    focusedBackground: grayAlpha[775][70],
  },
  light: {
    hoverBg: brandAlpha[100][30],
    focusedBackground: brandAlpha[100][30],
  },
};
