import type { ReactNode } from 'react';
import { Box } from '@mui/joy';

/** A keyboard shortcut hint: mono 11 px on a bordered key cap. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <Box
      component="kbd"
      sx={{
        fontFamily: 'code',
        fontSize: 11,
        lineHeight: 1.5,
        px: '5px',
        py: '1px',
        borderRadius: '4px',
        border: '1px solid',
        borderColor: 'admin.borderStrong',
        bgcolor: 'admin.surface',
        color: 'admin.inkMuted',
      }}
    >
      {children}
    </Box>
  );
}
