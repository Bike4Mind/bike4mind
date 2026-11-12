import { Stack, Typography } from '@mui/joy';
import { recommendDlqAction } from '@bike4mind/common';
import type { DlqMessage } from '@client/app/hooks/data/dlqManagement';
import { StatusChip } from './shared';

export const DlqRecommendation = ({ message }: { message: DlqMessage }) => {
  const recommendation = message.recommendation ?? recommendDlqAction({ category: message.failure?.category });
  return (
    <Stack gap={0.5} data-testid={`dlq-recommendation-${message.messageId}`}>
      <StatusChip tone="neutral" label={recommendation.label} />
      <Typography level="body-xs">{recommendation.basis}</Typography>
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
        Advisory only; review before acting.
      </Typography>
    </Stack>
  );
};
