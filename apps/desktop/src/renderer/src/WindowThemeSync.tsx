import { useEffect } from 'react';
import { useColorScheme, useTheme } from '@mui/joy/styles';

export function WindowThemeSync(): null {
  const theme = useTheme();
  // Preserve system mode: forcing its resolved value would also pin Chromium's media query.
  const { mode } = useColorScheme();
  const backgroundColor = theme.palette.background.surface;

  useEffect(() => {
    // The mini Tavern window has no `b4m` bridge (preload/mini.ts); its frame follows the system.
    if (!mode || !('b4m' in window)) return;
    void window.b4m.setTheme(mode, backgroundColor).catch((error: unknown) => {
      console.warn('Could not sync native window theme:', error);
    });
  }, [mode, backgroundColor]);

  return null;
}
