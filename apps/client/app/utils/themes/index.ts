import type { PaletteRange } from '@mui/joy/styles';

declare module '@mui/joy/styles' {
  interface Theme {
    branding: {
      id: string;
      name: string;
      modeToggleEnabled: boolean;
      logo: {
        light: string;
        dark: string;
      };
    };
  }

  interface ColorPalettePropOverrides {
    // @deprecated There is no associated color for this.
    secondary: true;
  }

  interface PaletteBackgroundOverrides {
    sidebarItem: true;
    scrollbar: true;
    scrollbarTrack: true;
    panel2: true;
    surface2: true;
  }
  interface PaletteTextOverrides {
    navLinks: true;
  }
  interface Palette {
    // @deprecated There is no associated color for this.
    secondary: PaletteRange;
    /**
     * Navbar related colors
     */
    navbar: {
      background: string;
      separator: string;
      text: string;
    };
    sidenav: {
      blueBack?: string;
      ctaSubscribe?: string;
      textColor?: string | undefined;
      navItemText?: string;
      navItemIcon?: string;
      chipText?: string;
      chipIcon?: string;
      chipIconConnected?: string;
      filterActiveBg?: string;
      pinnedBackdrop?: string;
    };
    /**
     * Chatbox or the Prompt area related colors
     */
    chatbox: {
      topbarBg: string;
      replyBg: string;
      messageInputDivider: string;
      messageInputColor: string;
    };
    aiSettings: {
      background: string;
      cardBackground: string;
      cardBorderColor: string;
      tooltipArrowBorder: string;
      modelCard: {
        background: string;
        border: string;
        activeBorder: string;
        activeBackground: string;
        hoverBackground: string;
        hoverBorder: string;
      };
      modal: {
        borderColor: string;
      };
    };
    inbox: {
      border: {
        light: string;
        cancelButton: string;
      };
      text: {
        disabledTab: string;
        placeholder: string;
      };
      backgroundColor: {
        textInput: string;
        inviteIcon: string;
      };
    };
    searchbar: {
      border: string;
      background: string;
      color: string;
    };
    tablist: {
      focusedBorder: string;
      focusedBackground: string;
    };
    fileBrowser: {
      surface: string;

      borderColor: string;
      fileIconColor: string;
      fileSizeColor: string;
      lightTextColor: string;
      buttons: {
        activeBackgroundColor: string;
        activeHoverBackgroundColor: string;
        hoverBackgroundColor: string;
        mainBlueBorderColor: string;
      };
      list: {
        activeHoverBackgroundColor: string;
      };
      bottomBar: {
        background: string;
        borderTop: string;
      };
      selectAll: {
        borderColor: string;
      };
      bottomAddDisabled: {
        color: string;
        backgroundColor: string;
        borderColor: string;
      };
      bottomDelete: {
        textColor: string;
      };
      instructionChip: {
        dangerColor: string;
      };
      statusChip: {
        backgroundColor: string;
        textColor: string;
        borderColor: string;
      };
      item: {
        background: string;
      };
      tagList: {
        itemBackground: string;
        inactiveItemBorderColor: string;
        deleteIconColor: string;
      };
      fileGrid: {
        background: string;
        hover: string;
        checkbox: {
          checked: {
            background: string;
            border: string;
            hover: string;
            icon: string;
          };
        };
      };
      storage: {
        backgroundColor: string;
        dangerColor: string;
        progressColor: string;
        textColor: string;
        textColorDanger: string;
        warningColor: string;
      };
      createTag: {
        secondaryText: string;
        iconColor: string;
        backgroundColor: string;
        previewBorderColor: string;
        previewBackgroundColor: string;
        previewTextSecondaryColor: string;
      };
    };
    common: {
      // MUI Joy's PaletteCommon requires black/white; keep them so the augmented
      // `common` stays assignable to the base palette (required by tsgo / TS 7.0).
      black: string;
      white: string;
      toggleButton: {
        activeHoverBackground: string;
        inactiveBackground: string;
        inactiveBorder: string;
      };
      switchToggleGroup: {
        hoverColor: string;
      };
      switchSelector: {
        background: string;
        lightTextColor: string;
      };
      userCard: {
        borderColor: string;
      };
      overlay: {
        subtleBackground: string;
        subtleBorder: string;
      };
      imageActions: {
        backgroundColor: string;
      };
    };
    notebooklist: {
      focusedBackground: string;
      borderColor: string;
      background: string;
      hoverBg: string;
      textColor: string;
    };
    feedback: {
      background: string;
      border: string;
      bug: string;
      feedback: string;
      positive: string;
      thumbsDown: string;
    };
    analytics: {
      background: string;
      primary: string;
      text: string;
      grid: string;
    };
    project: {
      // Unified tokens
      border: string;
      fileIconColor: string;

      // Component-specific tokens
      projectCard: {
        shadowColor: string;
        descriptionColor: string;
      };
      systemPromptModal: {
        backgroundColor: string;
      };
    };
    profile: {
      border: string;
    };
    credits: {
      accountSelector: {
        backgroundColor: string;
        listboxBackground: string;
      };
      accountOption: {
        backgroundColor: string;
        borderColor: string;
        selectedBackground: string;
      };
      creditsChip: {
        backgroundColor: string;
        borderColor: string;
      };
    };
    creditsModal: {
      border: string;
      gradient: string;
    };
    shareModal: {
      sharedUsersBorder: string;
    };
    subscriptionModal: {
      background: string;
      border: string;
      linkColor: string;
      tabsBorderColor: string;
      tabsBackgroundColor: string;
    };
    subscription: {
      creditsModal: {
        subtitleColor: string;
        dividerBackground: string;
        iconFill: string;
      };
    };
    loginRegister: {
      inputFieldBg: string;
      termsAndPrivacy: {
        hoverBg: string;
        buttonBg: string;
        border: string;
      };
    };
    session: {
      filesBannerBg: string;
      boxShadow: string;
      dividerBg: string;
      iconFill: string;
      collapseIndicator: string;
      cardBorder: string;
      activityBorder: string;
      hoverBackground: string;
      cardHoverBackground: string;
      announcementBackground: string;
      shadowLight: string;
      overlayBackground: string;
      shadowSoft: string;
    };
    voiceModal: {
      statusColors: {
        connecting: string;
        connected: string;
        disconnected: string;
        unknown: string;
      };
      dialog: {
        background: string;
        border: string;
        boxShadow: string;
      };
      statusContainer: {
        backgroundColor: string;
        border: string;
      };
      micButton: {
        backgroundColor: string;
      };
      audioVisualization: {
        user: string;
        assistant: string;
      };
    };
  }
}

declare module '@mui/joy/Button' {
  interface ButtonPropsColorOverrides {
    navItem: true;
  }

  interface ButtonPropsSizeOverrides {
    xs: true;
    xl: true;
  }
}

// Performance-optimized theme provider
export { default as AppTheme } from './AppTheme';

// Theme primitives and building blocks
export * from './themePrimitives';
export * from './customizations/input';
export * from './customizations/navigation';
export * from './customizations/tooltip';

// Individual component themes (for advanced customization)
export * from './components';
