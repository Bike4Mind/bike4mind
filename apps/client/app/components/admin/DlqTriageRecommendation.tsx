import { Button, Stack, Typography } from '@mui/joy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminAiSuggestionItem } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { AdminPermissionAction } from './shared/MissingPermission';

export function DlqTriageRecommendation({
  queueLabel,
  messageId,
  onApprove,
}: {
  queueLabel: string;
  messageId: string;
  onApprove: (suggestion: AdminAiSuggestionItem) => void;
}) {
  const client = useQueryClient();
  const key = ['admin', 'dlq', 'triage', queueLabel, messageId];
  const query = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        await api.get<{ suggestion: AdminAiSuggestionItem | null }>('/api/admin/dlq/triage', {
          params: { queue: queueLabel, message: messageId },
        })
      ).data.suggestion,
  });
  const dismiss = useMutation({
    mutationFn: async () =>
      api.post('/api/admin/dlq/triage', {
        queue: queueLabel,
        message: messageId,
        suggestionId: query.data?.id,
        decision: 'dismiss',
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  const suggestion = query.data;
  if (!suggestion) return null;
  return (
    <Stack gap={1} data-testid={`dlq-triage-${messageId}`} onClick={event => event.stopPropagation()}>
      <Typography level="body-xs">
        {suggestion.verdict}: {suggestion.reasons[0]?.text}
      </Typography>
      <Typography level="body-xs">
        {suggestion.actionClass} - {suggestion.status}
      </Typography>
      {suggestion.status === 'pending' && (
        <AdminPermissionAction requirement="settings:manage">
          {disabled => (
            <Stack direction="row" gap={1}>
              {suggestion.verdict === 'replay' && (
                <Button
                  size="sm"
                  disabled={disabled}
                  data-testid={`dlq-triage-approve-${messageId}`}
                  onClick={() => onApprove(suggestion)}
                >
                  Approve
                </Button>
              )}
              <Button
                size="sm"
                variant="plain"
                disabled={disabled || dismiss.isPending}
                data-testid={`dlq-triage-dismiss-${messageId}`}
                onClick={() => dismiss.mutate()}
              >
                Dismiss
              </Button>
            </Stack>
          )}
        </AdminPermissionAction>
      )}
      {dismiss.isError && <Typography level="body-xs">Dismiss failed. Refresh and try again.</Typography>}
      {suggestion.verdict === 'discard' && suggestion.status === 'pending' && (
        <Typography level="body-xs">
          Use the audited Discard action in the updated console. Discard approval integration is pending the base
          update.
        </Typography>
      )}
    </Stack>
  );
}
