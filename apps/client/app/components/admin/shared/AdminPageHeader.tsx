import { adminFocusScope } from './adminStyles';
import type { ReactNode } from 'react';
import { Box, Stack, Typography } from '@mui/joy';

export type AdminPageHeaderProps = { title: string; count?: number; description?: ReactNode; actions?: ReactNode };
export function AdminPageHeader({ title, count, description, actions }: AdminPageHeaderProps) {
  return (
    <Stack
      sx={adminFocusScope}
      direction={{ xs: 'column', sm: 'row' }}
      gap={2}
      justifyContent="space-between"
      data-testid="admin-page-header"
    >
      <Box>
        <Typography level="h3" sx={{ color: 'admin.ink' }}>
          {title}
          {count !== undefined && ` (${count.toLocaleString()})`}
        </Typography>
        {description && (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            {description}
          </Typography>
        )}
      </Box>
      {actions && (
        <Stack direction="row" gap={1} flexWrap="wrap">
          {actions}
        </Stack>
      )}
    </Stack>
  );
}
