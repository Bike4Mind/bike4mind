import { gray, grayAlpha, brandAlpha, greenAlpha } from '../colors';

// Custom values with unique opacity not in theme defaults
export const aiSettingsTheme = {
  dark: {
    background: gray[875], // Unified: was inputBackground + backgroundColor
    cardBackground: gray[900],
    cardBorderColor: brandAlpha[100][15],
    tooltipArrowBorder: `${gray[800]} ${gray[800]} transparent transparent`,
    modelCard: {
      background: gray[900],
      border: `1px solid ${brandAlpha[100][15]}`,
      activeBorder: `1px solid ${greenAlpha[800][50]}`,
      activeBackground: greenAlpha[800][2],
      hoverBackground: grayAlpha[775][25],
      hoverBorder: `1px solid ${brandAlpha[100][15]}`,
    },
    modal: {
      borderColor: grayAlpha[150][30],
    },
  },
  light: {
    background: gray[0], // Unified: was inputBackground + backgroundColor
    cardBackground: gray[0],
    cardBorderColor: grayAlpha[150][50],
    tooltipArrowBorder: `${gray[100]} ${gray[100]} transparent transparent`,
    modelCard: {
      background: gray[0],
      border: `1px solid ${grayAlpha[150][50]}`,
      activeBorder: `1px solid ${greenAlpha[800][50]}`,
      activeBackground: greenAlpha[800][2],
      hoverBackground: `linear-gradient(0deg, ${gray[0]}, ${gray[0]}), linear-gradient(0deg, ${brandAlpha[100][20]}, ${brandAlpha[100][20]})`,
      hoverBorder: `1px solid ${grayAlpha[150][50]}`,
    },
    modal: {
      borderColor: grayAlpha[150][50],
    },
  },
};
