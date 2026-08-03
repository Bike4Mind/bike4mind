import { gray, grayAlpha, brandAlpha, greenAlpha } from '../colors';

// Custom values with unique opacity not in theme defaults
export const aiSettingsTheme = {
  dark: {
    background: gray[875], // Unified: was inputBackground + backgroundColor
    cardBackground: gray[900],
    cardBorderColor: brandAlpha[100][15],
    tooltipArrowBorder: `${gray[800]} ${gray[800]} transparent transparent`,
    modelCard: {
      background: gray[850],
      border: `1px solid ${brandAlpha[100][15]}`,
      activeBorder: `1px solid ${greenAlpha[800][50]}`,
      // Layered over `background` rather than replacing it, so the selected tint reads as a
      // wash on the card instead of a different surface. Same green as activeBorder.
      activeBackground: greenAlpha[800][4],
      // Same tint as the sidenav rows (gray[775]) but a step down in alpha: a card is a much
      // larger fill area than a nav row, so the sidebar's 70% reads far heavier here. Matches
      // the file-browser row hover.
      hoverBackground: grayAlpha[775][50],
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
      activeBackground: greenAlpha[800][4],
      hoverBackground: brandAlpha[100][25],
      hoverBorder: `1px solid ${grayAlpha[150][50]}`,
    },
    modal: {
      borderColor: grayAlpha[150][50],
    },
  },
};
