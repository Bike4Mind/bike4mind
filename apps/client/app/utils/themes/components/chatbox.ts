import { brand, gray, grayAlpha, unique } from '../colors';

export const chatboxTheme = {
  dark: {
    topbarBg: unique.solidDisabledColor,
    replyBg: brand[700],
    messageInputDivider: grayAlpha[200][20],
    messageInputColor: gray[200],
  },
  light: {
    topbarBg: gray[100],
    replyBg: gray[75],
    messageInputDivider: gray[150],
    messageInputColor: brand[600],
  },
};
