import { gray, brand, brandAlpha, grayAlpha, blackAlpha, orange, green, red, whiteAlpha, blue } from '../colors';

// Modal themes - custom values with unique opacity not in theme defaults
export const modalsTheme = {
  credits: {
    dark: {
      border: brandAlpha[100][8],
      gradient: `linear-gradient(${brandAlpha[800][5]}, ${brandAlpha[800][10]}), ${gray[825]}`,
    },
    light: {
      border: grayAlpha[150][30],
      gradient: `linear-gradient(${brandAlpha[800][1]}, ${brandAlpha[800][2]}), ${gray[0]}`,
    },
  },
  subscription: {
    dark: {
      background: 'neutral.800',
      border: brandAlpha[100][8],
      linkColor: 'neutral.100',
      tabsBorderColor: 'neutral.700',
      tabsBackgroundColor: 'neutral.800',
    },
    light: {
      background: gray[0],
      border: grayAlpha[150][50],
      linkColor: brand[400],
      tabsBorderColor: grayAlpha[160][50],
      tabsBackgroundColor: gray[12],
    },
  },
  share: {
    dark: {
      sharedUsersBorder: gray[925],
    },
    light: {
      sharedUsersBorder: gray[200],
    },
  },
  voiceModal: {
    dark: {
      statusColors: {
        connecting: orange[625],
        connected: green[375],
        disconnected: red[375],
        unknown: gray[690],
      },
      dialog: {
        background: `linear-gradient(135deg, ${gray[860]} 0%, ${gray[870]} 100%)`,
        border: gray[725],
        boxShadow: blackAlpha[0][50],
      },
      statusContainer: {
        backgroundColor: grayAlpha[725][30],
        border: grayAlpha[725][50],
      },
      micButton: {
        backgroundColor: whiteAlpha[0][10],
      },
      audioVisualization: {
        user: green[450],
        assistant: brand[500],
      },
    },
    light: {
      statusColors: {
        connecting: orange[650],
        connected: green[650],
        disconnected: red[550],
        unknown: gray[685],
      },
      dialog: {
        background: `linear-gradient(135deg, ${gray[0]} 0%, ${gray[15]} 100%)`,
        border: gray[188],
        boxShadow: blackAlpha[0][15],
      },
      statusContainer: {
        backgroundColor: blackAlpha[0][3],
        border: blackAlpha[0][6],
      },
      micButton: {
        backgroundColor: blackAlpha[0][10],
      },
      audioVisualization: {
        user: green[550],
        assistant: blue[800],
      },
    },
  },
};
