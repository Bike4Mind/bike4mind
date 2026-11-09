import { designTokens, emitJoyThemeFragment } from '@bike4mind/design-tokens';
import { adminPalette } from './admin';
import { APP_NAME } from '@client/config/general';
import {
  aiSettingsTheme,
  chatboxTheme,
  readingTheme,
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

// The core palette (text, background, border, divider, interaction tones) is
// emitted from the canonical design tokens; the component-specific palette
// groups below stay web-side mappings on top of the same primitives.
const joyTokens = emitJoyThemeFragment(designTokens);

/**
 * Color schemes for light and dark modes.
 */
export const colorSchemes = {
  dark: {
    palette: {
      ...joyTokens.colorSchemes.dark.palette,
      // Component-specific palette tokens
      sidenav: sidenavTheme.dark,
      aiSettings: aiSettingsTheme.dark,
      inbox: inboxTheme.dark,
      chatbox: chatboxTheme.dark,
      reading: readingTheme.dark,
      admin: adminPalette.dark,
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
      creditsModal: modalsTheme.credits.dark,
      subscriptionModal: modalsTheme.subscription.dark,
      shareModal: modalsTheme.share.dark,
      loginRegister: loginRegisterTheme.dark,
      voiceModal: modalsTheme.voiceModal.dark,
    },
  },
  light: {
    palette: {
      ...joyTokens.colorSchemes.light.palette,
      // Component-specific palette tokens
      sidenav: sidenavTheme.light,
      aiSettings: aiSettingsTheme.light,
      inbox: inboxTheme.light,
      chatbox: chatboxTheme.light,
      reading: readingTheme.light,
      admin: adminPalette.light,
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
  fontFamily: joyTokens.fontFamily,
};

/**
 * Shape configuration
 */
export const shape = {
  borderRadius: joyTokens.borderRadius,
};

/**
 * Branding configuration
 */
export const branding = {
  id: 'bike4mind',
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
