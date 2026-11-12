import { useEffect } from 'react';
import { useColorScheme, useTheme } from '@mui/joy/styles';

export function WindowThemeSync(): null {
  const theme = useTheme();
  // Preserve system mode: forcing its resolved value would also pin Chromium's media query.
  const { mode } = useColorScheme();
  const backgroundColor = theme.palette.background.surface;

  useEffect(() => {
    if (mode) void window.b4m.setTheme(mode, backgroundColor);
  }, [mode, backgroundColor]);

  return null;
}
