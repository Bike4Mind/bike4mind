import { gray, unique, grayAlpha } from '../colors';

// Uses gray[50] for background.surface; color not defined in colors.
export const searchbarTheme = {
  dark: {
    background: gray[900],
    color: grayAlpha[0][50],
  },
  light: {
    background: gray[0],
    color: unique.mediumGray,
  },
};
