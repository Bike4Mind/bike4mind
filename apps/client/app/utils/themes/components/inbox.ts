import { brand, gray, brandAlpha, grayAlpha } from '../colors';

// Custom values with unique opacity not in theme defaults
export const inboxTheme = {
  dark: {
    border: {
      light: gray[700],
      cancelButton: gray[600],
    },
    text: {
      disabledTab: brandAlpha[100][70],
      placeholder: gray[700],
    },
    backgroundColor: {
      textInput: gray[900],
      inviteIcon: gray[900],
    },
  },
  light: {
    border: {
      light: grayAlpha[150][50],
      cancelButton: brand[400],
    },
    text: {
      disabledTab: brandAlpha[400][50],
      placeholder: brandAlpha[400][25],
    },
    backgroundColor: {
      textInput: gray[0],
      inviteIcon: gray[10],
    },
  },
};
