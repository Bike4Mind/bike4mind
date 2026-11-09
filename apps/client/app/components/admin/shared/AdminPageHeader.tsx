import { adminFocusScope } from './adminStyles';
import type { ReactNode } from 'react';
import { Box, Stack, Typography } from '@mui/joy';

export type AdminPageHeaderProps = {
  title: string;
  count?: number;
  description?: ReactNode;
  actions?: ReactNode;
  /** 'section' for a sub-view rendered under a page that already has its own page title. */
  level?: 'page' | 'section';
};
export function AdminPageHeader({ title, count, description, actions, level = 'page' }: AdminPageHeaderProps) {
  return (
    <Stack
      sx={adminFocusScope}
      direction={{ xs: 'column', sm: 'row' }}
      gap={2}
      justifyContent="space-between"
      data-testid="admin-page-header"
    >
      <Box>
        <Typography level={level === 'page' ? 'h1' : 'h2'} sx={{ color: 'admin.ink' }}>
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
        // A long description must wrap before an action button does: the title block shrinks, the
        // actions keep their width.
        <Stack direction="row" gap={1} flexWrap="wrap" sx={{ flexShrink: 0 }} data-testid="admin-page-header-actions">
          {actions}
        </Stack>
      )}
    </Stack>
  );
}
