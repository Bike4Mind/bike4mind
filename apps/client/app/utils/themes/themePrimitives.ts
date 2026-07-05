import {
  brand,
  gray,
  green,
  blue,
  red,
  orange,
  brandAlpha,
  grayAlpha,
  unique,
  cyan,
  tealAlpha,
  redAlpha,
  greenAlpha,
  orangeAlpha,
} from './colors';
import { APP_NAME } from '@client/config/general';
import {
  aiSettingsTheme,
  chatboxTheme,
  commonTheme,
  creditsTheme,
  fileBrowserTheme,
  modalsTheme,
  inboxTheme,
  loginRegisterTheme,
  notebooklistTheme,
  profileTheme,
  projectTheme,
  quickActionsTheme,
  searchbarTheme,
  sessionTheme,
  sidenavTheme,
  subscriptionTheme,
} from './components';

declare module '@mui/joy/styles' {
  interface PaletteBackground {
    panel?: string;
  }

  interface Palette {
    text: {
      // MUI Joy's PaletteText requires `icon`; keep it so the augmented `text`
      // stays assignable to the base palette (required by tsgo / TS 7.0).
      icon: string;
      navLinks: string;
      primary: string;
      primary50: string;
      primary70: string;
      secondary: string;
      tertiary: string;
    };
    border: {
      light: string;
      solid: string;
      input: string;
      muted: string;
      soft: string;
    };
    quickActions: {
      notebook: {
        color: string;
      };
      project: {
        color: string;
      };
      agent: {
        color: string;
      };
      file: {
        color: string;
      };
    };
    promptEnhancement: {
      background: string;
      backgroundHover: string;
      border: string;
      iconColor: string;
      textColor: string;
      chipBackground: string;
      chipColor: string;
      chipBorder: string;
      enhancedPromptBackground: string;
      enhancedPromptBorder: string;
    };
  }
}

export { brand, gray, green, blue, red, orange, brandAlpha, grayAlpha, unique, cyan, tealAlpha } from './colors';
/**
 * Color schemes for light and dark modes.
 */
export const colorSchemes = {
  dark: {
    palette: {
      // Match the outlined-border stroke so dividers and borders share one color.
      divider: gray[800], // #2C3135
      text: {
        navLinks: cyan[300],
        icon: brandAlpha[100][50],
        primary: brand[100],
        primary50: brandAlpha[100][50],
        primary70: brandAlpha[100][70],
        secondary: brandAlpha[100][70],
        tertiary: brandAlpha[100][50],
      },
      border: {
        light: brandAlpha[100][15],
        solid: gray[800],
        input: gray[800],
        muted: grayAlpha[150][20],
        soft: brandAlpha[100][8],
      },
      background: {
        sidebarItem: grayAlpha[775][30],
        body: gray[900],
        scrollbar: brand[600],
        scrollbarTrack: gray[900],
        surface: gray[900],
        surface2: gray[850],
        panel: gray[850],
        panel2: gray[850],
      },
      primary: {
        // Tabs
        softBg: gray[850],
        softActiveBg: brand[700],
        softHoverBg: grayAlpha[775][70],
        softHoverColor: unique.softHoverColor,
        solidDisabledBg: gray[650],
        solidDisabledColor: unique.solidDisabledColor,
        softColor: gray[200],
      },
      success: {
        solidBg: green[900],
        outlinedColor: green[375],
        outlinedBorder: green[375],
        mainChannel: gray[200],
        softBg: greenAlpha[375][15],
        softHoverBg: greenAlpha[375][22],
        softActiveBg: greenAlpha[375][28],
        softColor: green[375],
      },
      danger: {
        solidBg: red[600],
        solidHoverBg: red[700],
        solidActiveBg: red[700],
        outlinedColor: red[400],
        outlinedBorder: red[400],
        softBg: redAlpha[400][15],
        softHoverBg: redAlpha[400][22],
        softActiveBg: redAlpha[400][28],
        softColor: red[375],
        mainChannel: red[400],
      },
      warning: {
        softBg: orangeAlpha[375][15],
        softHoverBg: orangeAlpha[375][22],
        softActiveBg: orangeAlpha[375][28],
        softColor: orange[375],
        outlinedColor: orange[375],
        outlinedBorder: orange[375],
      },
      feedback: {
        background: gray[850],
        border: `1px solid ${gray[800]}`,
        bug: red[500], // Softer red
        feedback: blue[500], // Muted blue
        positive: green[600], // Unified: was success + thumbsUp
        thumbsDown: orange[300],
      },
      neutral: {
        solidBg: gray[850],
        solidColor: gray[200],
        softColor: gray[200],
        // Single source of truth for every outlined+neutral component border
        // (IconButtons, Buttons, Inputs, Cards, the footer chips, ...). gray[800]
        // is the design's "stroke" token (#2C3135).
        outlinedBorder: gray[800],
        outlinedHoverBg: grayAlpha[775][70],
        plainActiveBg: brand[700],
      },
      // Component-specific palette tokens
      sidenav: sidenavTheme.dark,
      aiSettings: aiSettingsTheme.dark,
      inbox: inboxTheme.dark,
      chatbox: chatboxTheme.dark,
      common: commonTheme.dark,
      credits: creditsTheme.dark,
      searchbar: searchbarTheme.dark,
      fileBrowser: fileBrowserTheme.dark,
      session: sessionTheme.dark,
      notebooklist: notebooklistTheme.dark,
      subscription: subscriptionTheme.dark,
      profile: profileTheme.dark,
      project: projectTheme.dark,
      quickActions: quickActionsTheme,
      promptEnhancement: {
        background: brandAlpha[800][20],
        backgroundHover: brandAlpha[800][10],
        border: brandAlpha[800][20],
        iconColor: brand[100],
        textColor: brand[100],
        chipBackground: gray[800],
        chipColor: brand[100],
        chipBorder: gray[800],
        enhancedPromptBackground: tealAlpha.custom[5],
        enhancedPromptBorder: brandAlpha[800][25],
      },
      creditsModal: modalsTheme.credits.dark,
      subscriptionModal: modalsTheme.subscription.dark,
      shareModal: modalsTheme.share.dark,
      loginRegister: loginRegisterTheme.dark,
      voiceModal: modalsTheme.voiceModal.dark,
    },
  },
  light: {
    palette: {
      text: {
        navLinks: brand[600],
        icon: brandAlpha[400][50],
        primary: brand[400],
        primary50: brandAlpha[400][50],
        primary70: brandAlpha[400][70],
        secondary: brandAlpha[400][60],
        tertiary: brandAlpha[400][50],
      },
      border: {
        light: gray[150],
        solid: gray[150],
        input: brand[100],
        muted: grayAlpha[150][20],
        soft: brandAlpha[100][50],
      },
      divider: gray[200],
      background: {
        sidebarItem: 'neutral.200',
        body: gray[10],
        scrollbar: unique.scrollbar,
        scrollbarTrack: gray[50],
        surface: gray[50],
        surface2: gray[50],
        panel: gray[10],
        panel2: gray[0],
      },
      primary: {
        solidBg: blue[600],
        solidColor: gray[0],
        // Tabs
        softBg: gray[0],
        softActiveBg: brand[100],
        softActiveColor: brand[700],
        softHoverBg: brandAlpha[100][30],
        softHoverColor: brand[700],
        softColor: brand[600],
      },
      success: {
        solidBg: green[800],
        outlinedColor: brand[600],
        mainChannel: brand[600],
      },
      danger: {
        solidBg: red[600],
        solidHoverBg: red[700],
        solidActiveBg: red[700],
        outlinedColor: red[600],
        outlinedBorder: red[600],
        softBg: red[250],
        softColor: red[600],
        mainChannel: red[600],
      },
      neutral: {
        solidBg: gray[0],
        solidBorder: `2px solid ${brand[600]} !important`,
        solidColor: brand[600],
        softColor: brand[600],
        plainActiveBg: brand[100],
      },
      feedback: {
        background: gray[50],
        border: `1px solid ${gray[200]}`,
        bug: red[500], // Softer red
        feedback: blue[500], // Muted blue
        positive: green[600], // Unified: was success + thumbsUp
        thumbsDown: orange[300],
      },
      // Component-specific palette tokens
      sidenav: sidenavTheme.light,
      aiSettings: aiSettingsTheme.light,
      inbox: inboxTheme.light,
      chatbox: chatboxTheme.light,
      common: commonTheme.light,
      credits: creditsTheme.light,
      searchbar: searchbarTheme.light,
      fileBrowser: fileBrowserTheme.light,
      session: sessionTheme.light,
      notebooklist: notebooklistTheme.light,
      subscription: subscriptionTheme.light,
      profile: profileTheme.light,
      project: projectTheme.light,
      quickActions: quickActionsTheme,
      promptEnhancement: {
        background: unique.lightBlueOverlay,
        backgroundHover: brandAlpha[100][20],
        border: brand[100],
        iconColor: brand[600],
        textColor: brand[600],
        chipBackground: brandAlpha[100][50],
        chipColor: brand[600],
        chipBorder: gray[150],
        enhancedPromptBackground: brandAlpha[100][12],
        enhancedPromptBorder: gray[150],
      },
      creditsModal: modalsTheme.credits.light,
      subscriptionModal: modalsTheme.subscription.light,
      shareModal: modalsTheme.share.light,
      loginRegister: loginRegisterTheme.light,
      voiceModal: modalsTheme.voiceModal.light,
    },
  },
};

/**
 * Typography configuration
 */
export const typography = {
  fontFamily: {
    body: '"Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    display: '"Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
};

/**
 * Shape configuration
 */
export const shape = {
  borderRadius: 8,
};

/**
 * Branding configuration
 */
export const branding = {
  id: 'groktool',
  // Display brand name externalized for open-core; id stays a stable theme key.
  name: APP_NAME, // single-source brand name, no re-reading the raw env var
  modeToggleEnabled: true,
  logo: {
    light: '/icons/Colored_Logo_Clean.svg',
    dark: '/icons/Colored_Logo_Clean.svg',
  },
};

/**
 * Component overrides for global styling
 */
export const components = {
  JoyButton: {
    styleOverrides: {
      root: {
        '--joy-focus-thickness': '0px',
        '--joy-palette-focusVisible': 'transparent',
        '--focus-outline-offset': '0px',
        '&:focus': {
          outline: 'none !important',
          boxShadow: 'none !important',
        },
        '&:focus-visible': {
          outline: 'none !important',
          boxShadow: 'none !important',
        },
        '&.Mui-focusVisible': {
          outline: 'none !important',
          boxShadow: 'none !important',
        },
      },
    },
  },
  JoyIconButton: {
    styleOverrides: {
      root: {
        '--joy-focus-thickness': '0px',
        '--joy-palette-focusVisible': 'transparent',
        '--focus-outline-offset': '0px',
        '&:focus': {
          outline: 'none !important',
          boxShadow: 'none !important',
        },
        '&:focus-visible': {
          outline: 'none !important',
          boxShadow: 'none !important',
        },
        '&.Mui-focusVisible': {
          outline: 'none !important',
          boxShadow: 'none !important',
        },
      },
    },
  },
  JoyInput: {
    styleOverrides: {
      input: {
        color: 'var(--joy-palette-text-primary)',
      },
    },
  },
  JoyTextarea: {
    styleOverrides: {
      textarea: {
        color: 'var(--joy-palette-text-primary)',
      },
    },
  },
  JoySelect: {
    styleOverrides: {
      root: {
        color: 'var(--joy-palette-text-primary)',
      },
    },
  },
};

/**
 * Creates the base theme configuration with color schemes
 * This function can be memoized for performance optimization
 */
export const getThemeConfig = () => ({
  colorSchemes,
  ...typography,
  ...shape,
  branding,
  components,
});
