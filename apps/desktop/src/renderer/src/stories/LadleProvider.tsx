import { useEffect } from 'react';
import type { GlobalProvider, LadleTheme } from './ladleTypes';
import CssBaseline from '@mui/joy/CssBaseline';
import { CssVarsProvider, useColorScheme } from '@mui/joy/styles';
import { desktopTheme } from '../theme';
import '../scrollbars.css';

function LadleModeSync({ theme }: { theme: LadleTheme }): null {
  const { setMode } = useColorScheme();
  useEffect(() => {
    setMode(theme === 'auto' ? 'system' : theme);
  }, [theme, setMode]);
  return null;
}

/**
 * Mirrors the provider stack in ../main.tsx so a story renders under the theme the app ships.
 * viewport.css is left out on purpose: it stops the document scrolling, which a story page needs.
 */
export const Provider: GlobalProvider = ({ children, globalState }) => (
  <CssVarsProvider theme={desktopTheme} defaultMode="system">
    <CssBaseline />
    <LadleModeSync theme={globalState.theme} />
    {children}
  </CssVarsProvider>
);
