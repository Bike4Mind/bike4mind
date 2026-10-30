import type { ReactNode } from 'react';
import { Box, Stack, Typography } from '@mui/joy';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { StatusChip } from './StatusChip';

type ChangePreviewProps = {
  before: ReactNode;
  after: ReactNode;
  /** A signed delta or a short verdict ("No change"), shown as a chip on the right. */
  delta?: { label: string; tone: AdminStatusTone };
  'data-testid': string;
};

/** The before -> after preview inside an ActionDialog (DESIGN_GUIDE.md section 1, principle 3). */
export function ChangePreview({ before, after, delta, 'data-testid': testId }: ChangePreviewProps) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      flexWrap="wrap"
      gap={1.5}
      data-testid={testId}
      sx={{
        px: 2,
        py: 1.75,
        borderRadius: 'lg',
        bgcolor: 'admin.surface',
        border: '1px solid',
        borderColor: 'admin.border',
      }}
    >
      <PreviewValue label="Before" value={before} testId={`${testId}-before`} />
      <ArrowForwardRoundedIcon aria-hidden sx={{ fontSize: 20, color: 'admin.inkMuted' }} />
      <PreviewValue label="After" value={after} testId={`${testId}-after`} />
      {delta && (
        <Box sx={{ ml: 'auto' }} data-testid={`${testId}-delta`}>
          <StatusChip tone={delta.tone} label={delta.label} />
        </Box>
      )}
    </Stack>
  );
}

function PreviewValue({ label, value, testId }: { label: string; value: ReactNode; testId: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
        {label}
      </Typography>
      <Typography
        component="div"
        data-testid={testId}
        sx={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'admin.ink' }}
      >
        {value}
      </Typography>
    </Box>
  );
}
