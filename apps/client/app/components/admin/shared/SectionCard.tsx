import type { ReactNode } from 'react';
import { Box, Sheet, Stack, Typography } from '@mui/joy';
import { adminSurface } from './adminStyles';

export function SectionCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Sheet variant="outlined" sx={{ ...adminSurface, p: 2 }} data-testid="admin-section-card">
      <Stack direction="row" justifyContent="space-between" gap={1} alignItems="center">
        <Typography level="title-md" sx={{ color: 'admin.ink' }}>
          {title}
        </Typography>
        {action}
      </Stack>
      <Box component="dl" sx={{ m: 0, mt: 2 }}>
        {children}
      </Box>
    </Sheet>
  );
}
