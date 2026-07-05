import { brand, gray, grayAlpha, brandAlpha, whiteAlpha, blackAlpha, unique, green, greenAlpha } from '../colors';

export const commonTheme = {
  dark: {
    black: '#000',
    white: '#fff',
    toggleButton: {
      activeHoverBackground: brand[700], // Unified: was activeBackground + hoverBackground
      inactiveBackground: grayAlpha[775][30],
      inactiveBorder: gray[800],
    },
    switchToggleGroup: {
      hoverColor: gray[0],
    },
    switchSelector: {
      background: 'background.level1',
      lightTextColor: brandAlpha[100][75],
    },
    userCard: {
      borderColor: brandAlpha[100][15],
    },
    overlay: {
      subtleBackground: whiteAlpha[0][5],
      subtleBorder: whiteAlpha[0][10],
    },
    imageActions: {
      backgroundColor: unique.almostBlack,
    },
    slideToggle: {
      backgroundOff: gray[830],
      backgroundOn: green[975],
      thumbOff: gray[690],
      thumbOn: green[600],
    },
  },
  light: {
    black: '#000',
    white: '#fff',
    toggleButton: {
      activeHoverBackground: gray[75], // Unified: was activeBackground + hoverBackground
      inactiveBackground: grayAlpha[175][12],
      inactiveBorder: 'transparent',
    },
    switchToggleGroup: {
      hoverColor: brand[400],
    },
    switchSelector: {
      background: gray[0],
      lightTextColor: brandAlpha[400][50],
    },
    userCard: {
      borderColor: grayAlpha[150][80],
    },
    overlay: {
      subtleBackground: blackAlpha[0][5],
      subtleBorder: blackAlpha[0][10],
    },
    imageActions: {
      backgroundColor: whiteAlpha[0][80],
    },
    slideToggle: {
      backgroundOff: gray[12],
      backgroundOn: greenAlpha[800][20],
      thumbOff: gray[160],
      thumbOn: green[800],
    },
  },
};
