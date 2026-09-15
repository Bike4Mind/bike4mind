import { brand, gray, brandAlpha, grayAlpha, greenAlpha } from '../colors';

export const creditsTheme = {
  dark: {
    accountSelector: {
      backgroundColor: gray[825],
      listboxBackground: gray[900],
    },
    accountOption: {
      backgroundColor: gray[825],
      borderColor: brandAlpha[100][15],
      selectedBackground: `linear-gradient(${greenAlpha[800][6]}, ${greenAlpha[800][4]}), ${gray[850]}`,
    },
    creditsChip: {
      backgroundColor: gray[850],
      borderColor: brandAlpha[100][20],
    },
  },
  light: {
    accountSelector: {
      backgroundColor: 'transparent',
      listboxBackground: 'transparent',
    },
    accountOption: {
      backgroundColor: gray[0],
      borderColor: grayAlpha[150][50],
      selectedBackground: `linear-gradient(${greenAlpha[800][8]}, ${greenAlpha[800][6]}), ${gray[0]}`,
    },
    creditsChip: {
      backgroundColor: gray[0],
      borderColor: brand[100],
    },
  },
};
