import { adminFocusScope } from './adminStyles';
import type { ReactNode } from 'react';
import { Stack, Typography } from '@mui/joy';
export type EmptyStateProps = { title: string; description?: string; action: ReactNode };
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <Stack alignItems="center" gap={1} sx={{ ...adminFocusScope, p: 3 }} data-testid="admin-empty-state" role="status">
      <Typography level="title-md" sx={{ color: 'admin.ink' }}>
        {title}
      </Typography>
      {description && (
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
          {description}
        </Typography>
      )}
      {action}
    </Stack>
  );
}
