import type { ReactNode } from 'react';
import Box from '@mui/joy/Box';
import { useTheme } from '@mui/joy/styles';
import type { SxProps } from '@mui/joy/styles/types';
import { desktopStudioVariables, studioColor } from './studioTokens';

/**
 * Declares the `--studio-*` tokens for everything inside it in the resolved colour mode, the Desktop
 * counterpart of web's StudioThemeScope. Studio styles read only these variables, so they stay scoped.
 */
export function StudioScope({ children, sx, testId }: { children: ReactNode; sx?: SxProps; testId?: string }) {
  const mode = useTheme().palette.mode;
  return (
    <Box
      data-studio-mode={mode}
      data-testid={testId}
      sx={[
        {
          ...desktopStudioVariables(mode),
          colorScheme: mode,
          bgcolor: studioColor('canvas'),
          color: studioColor('text'),
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {children}
    </Box>
  );
}
