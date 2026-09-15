import { brand, brandAlpha } from '../colors';

export const subscriptionTheme = {
  dark: {
    creditsModal: {
      subtitleColor: brand[100],
      dividerBackground: brandAlpha[100][8],
      iconFill: 'transparent',
    },
  },
  light: {
    creditsModal: {
      subtitleColor: brandAlpha[400][50],
      dividerBackground: 'transparent',
      iconFill: brandAlpha[400][50],
    },
  },
};
