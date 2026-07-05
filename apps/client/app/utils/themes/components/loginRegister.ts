import { gray, brandAlpha, grayAlpha } from '../colors';

// Custom values with unique opacity not in theme defaults
export const loginRegisterTheme = {
  dark: {
    inputFieldBg: gray[900],
    termsAndPrivacy: {
      hoverBg: grayAlpha[775][30],
      buttonBg: gray[850],
      border: `1px solid ${brandAlpha[100][20]}`,
    },
  },
  light: {
    inputFieldBg: gray[0],
    termsAndPrivacy: {
      hoverBg: brandAlpha[100][12],
      buttonBg: gray[0],
      border: `1px solid ${grayAlpha[150][50]}`,
    },
  },
};
