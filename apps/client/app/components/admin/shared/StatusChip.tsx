import { Chip } from '@mui/joy';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';

export function StatusChip({ tone, label }: { tone: AdminStatusTone; label: string }) {
  return (
    <Chip
      size="sm"
      data-testid="admin-status-chip"
      sx={theme => ({
        color: theme.vars.palette.admin.status[tone].foreground,
        bgcolor: theme.vars.palette.admin.status[tone].background,
      })}
    >
      {label}
    </Chip>
  );
}
