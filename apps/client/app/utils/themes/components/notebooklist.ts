import { grayAlpha, brandAlpha } from '../colors';

// Custom values with unique opacity not in theme defaults.
// Dark: selected (focusedBackground) matches hover, both #2A2C38 @ 70% (grayAlpha[775][70]).
// Light: hover is the light-blue tint @ 30%; selected is the same blue @ 50% so it reads a bit
// stronger than hover (brand[100] = #D1E4F4).
export const notebooklistTheme = {
  dark: {
    hoverBg: grayAlpha[775][70],
    focusedBackground: grayAlpha[775][70],
  },
  light: {
    hoverBg: brandAlpha[100][30],
    focusedBackground: brandAlpha[100][50],
  },
};
