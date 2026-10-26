import type { ReactNode } from 'react';
import { Box, Stack, Typography } from '@mui/joy';
import { adminSurface } from './adminStyles';

export type StatTileProps = { label: string; value: ReactNode; comparison?: ReactNode; sparkline?: ReactNode };
export function StatTile({ label, value, comparison, sparkline }: StatTileProps) {
  return (
    <Box
      data-testid="admin-stat-tile"
      sx={{ ...adminSurface, borderWidth: 1, borderStyle: 'solid', p: 2, flex: '1 1 0', minWidth: 0 }}
    >
      <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
        {label}
      </Typography>
      <Typography level="h3" sx={{ color: 'admin.ink', fontVariantNumeric: 'tabular-nums' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </Typography>
      {comparison && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          {comparison}
        </Typography>
      )}
      {sparkline}
    </Box>
  );
}
export function StatStrip({ children }: { children: ReactNode }) {
  return (
    <Stack data-testid="admin-stat-strip" direction={{ xs: 'column', sm: 'row' }} gap={2}>
      {children}
    </Stack>
  );
}
