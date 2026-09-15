import { brand, gray, grayAlpha } from '../colors';

export const chatboxTheme = {
  dark: {
    replyBg: brand[700],
    messageInputDivider: grayAlpha[200][20],
    messageInputColor: gray[200],
  },
  light: {
    replyBg: gray[75],
    messageInputDivider: gray[150],
    messageInputColor: brand[600],
  },
};
