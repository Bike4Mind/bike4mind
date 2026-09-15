import * as React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { Theme, Components } from '@mui/joy/styles';
import { getThemeConfig } from './themePrimitives';
import { inputCustomizations } from './customizations/input';
import { navigationCustomizations } from './customizations/navigation';
import { tooltipCustomizations } from './customizations/tooltip';
import { securityPaletteLight, securityPaletteDark } from '@client/app/theme/securityTheme'; // Includes type declarations

interface AppThemeProps {
  children: React.ReactNode;
  /**
   * Additional theme components to merge with the default customizations
   */
  themeComponents?: Components<Theme>;
  /**
   * Disable the custom theme and use MUI Joy's default theme
   * Useful for testing or fallback scenarios
   */
  disableCustomTheme?: boolean;
}

export default function AppTheme({ children, themeComponents, disableCustomTheme }: AppThemeProps) {
  const theme = React.useMemo(() => {
    if (disableCustomTheme) {
      return null;
    }

    const baseConfig = getThemeConfig();

    return extendTheme({
      ...baseConfig,
      colorSchemes: {
        light: {
          palette: {
            ...baseConfig.colorSchemes?.light?.palette,
            ...securityPaletteLight,
          },
        },
        dark: {
          palette: {
            ...baseConfig.colorSchemes?.dark?.palette,
            ...securityPaletteDark,
          },
        },
      },
      components: {
        ...inputCustomizations,
        ...navigationCustomizations,
        ...tooltipCustomizations,
        ...themeComponents,
      },
    });
  }, [disableCustomTheme, themeComponents]);

  if (disableCustomTheme) {
    return <React.Fragment>{children}</React.Fragment>;
  }

  return (
    <CssVarsProvider
      theme={theme || undefined}
      disableTransitionOnChange
      defaultMode="system"
      modeStorageKey="bike4mind-color-scheme"
    >
      {children}
    </CssVarsProvider>
  );
}
