import { brandAlpha, grayAlpha } from '../colors';

// Project component theme definitions for dark and light modes
export const projectTheme = {
  dark: {
    // Unified values
    border: brandAlpha[100][15],
    fileIconColor: brandAlpha[100][30],

    // Component-specific values
    projectCard: {
      shadowColor: brandAlpha[100][4],
      descriptionColor: brandAlpha[100][50],
    },
    systemPromptModal: {
      backgroundColor: brandAlpha[100][15],
    },
  },
  light: {
    // Unified values
    border: grayAlpha[150][80],
    fileIconColor: brandAlpha[400][30],

    // Component-specific values
    projectCard: {
      shadowColor: brandAlpha[400][7],
      descriptionColor: brandAlpha[400][60],
    },
    systemPromptModal: {
      backgroundColor: grayAlpha[150][80],
    },
  },
};
