import { Stack, Typography } from '@mui/joy';
import type { DlqMessage } from '@client/app/hooks/data/dlqManagement';
import { StatusChip } from './shared';

export const DlqRecommendation = ({ message }: { message: DlqMessage }) => {
  const recommendation = message.recommendation ?? {
    action: 'inspect',
    label: 'Inspect first',
    basis: 'Recommendation facts are unavailable. Inspect the message before acting.',
  };
  return (
    <Stack gap={0.5} data-testid={`dlq-recommendation-${message.messageId}`}>
      <StatusChip tone="neutral" label={recommendation.label} />
      <Typography level="body-xs">{recommendation.basis}</Typography>
    </Stack>
  );
};
