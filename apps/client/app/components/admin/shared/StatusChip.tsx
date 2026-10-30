import { Box, Chip } from '@mui/joy';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';

/** A 22 px status pill (12 / 500) with an optional 6 px dot in the same tone. */
export function StatusChip({
  tone,
  label,
  dot,
  'data-testid': testId,
}: {
  tone: AdminStatusTone;
  label: string;
  dot?: boolean;
  'data-testid'?: string;
}) {
  return (
    <Chip
      size="sm"
      data-testid={testId ?? 'admin-status-chip'}
      data-tone={tone}
      startDecorator={
        dot ? (
          <Box
            component="span"
            aria-hidden
            sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'currentColor' }}
          />
        ) : undefined
      }
      sx={theme => ({
        '--Chip-minHeight': '22px',
        '--Chip-decoratorChildHeight': '6px',
        minHeight: 22,
        px: 1,
        gap: '5px',
        fontSize: 12,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        color: theme.vars.palette.admin.status[tone].foreground,
        bgcolor: theme.vars.palette.admin.status[tone].background,
      })}
    >
      {label}
    </Chip>
  );
}
