import { brand, brandAlpha, gray, grayAlpha, unique, blackAlpha } from '../colors';

export const sessionTheme = {
  dark: {
    // SessionBottom overlay backgrounds
    filesBannerBg: grayAlpha[875][50],
    boxShadow: `-5px -10px 30px 0px ${grayAlpha[800][8]}, 5px 10px 30px 0px ${grayAlpha[800][8]}`,
    dividerBg: grayAlpha[800][50],

    iconFill: gray[0],
    collapseIndicator: gray[200],
    cardBorder: brandAlpha[100][15],
    activityBorder: brandAlpha[100][15],
    hoverBackground: grayAlpha[775][60],
    cardHoverBackground: grayAlpha[775][70],
    announcementBackground: brandAlpha[800][20],
    // Additional keys used in SessionContainer
    shadowLight: `0px 8px 24px ${blackAlpha[0][18]}`,
    overlayBackground: grayAlpha[775][30],
    shadowSoft: `0px 4px 16px ${blackAlpha[0][12]}`,
  },
  light: {
    // SessionBottom overlay backgrounds
    filesBannerBg: `${unique.lightBlueOverlay}80`,
    boxShadow: `0px -1px 25px 0px ${brandAlpha[600][4]}, 0px 1px 25px 0px ${brandAlpha[600][4]}`,
    dividerBg: grayAlpha[150][50],

    iconFill: brand[400],
    collapseIndicator: brand[600],
    cardBorder: grayAlpha[150][30],
    activityBorder: gray[150],
    hoverBackground: grayAlpha[200][60],
    cardHoverBackground: brandAlpha[100][20],
    announcementBackground: brandAlpha[800][10],
    // Additional keys used in SessionContainer
    shadowLight: `0px 8px 24px ${blackAlpha[0][8]}`,
    overlayBackground: grayAlpha[150][30],
    shadowSoft: `0px 4px 16px ${blackAlpha[0][6]}`,
  },
};
