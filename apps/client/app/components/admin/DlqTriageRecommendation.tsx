import { Button, Stack, Typography } from '@mui/joy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dlqTriageEvidenceSchema, type AdminAiSuggestionItem, type DlqTriageExecution } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { AdminPermissionAction } from './shared/MissingPermission';
import { useState } from 'react';
import { ActionDialog } from './shared/ActionDialog';
import { toast } from 'sonner';

export function DlqTriageRecommendation({ queueLabel, messageId }: { queueLabel: string; messageId: string }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const client = useQueryClient();
  const key = ['admin', 'dlq', 'triage', queueLabel, messageId];
  const query = useQuery({
    queryKey: key,
    queryFn: async () =>
      (
        await api.get<{ suggestion: AdminAiSuggestionItem | null; execution: DlqTriageExecution | null }>(
          '/api/admin/dlq/triage',
          {
            params: { queue: queueLabel, message: messageId },
          }
        )
      ).data,
  });
  const dismiss = useMutation({
    mutationFn: async () =>
      api.post('/api/admin/dlq/triage', {
        queue: queueLabel,
        message: messageId,
        suggestionId: query.data?.suggestion?.id,
        decision: 'dismiss',
      }),
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
  const suggestion = query.data?.suggestion;
  const execution = query.data?.execution;
  const proposedAction = suggestion?.proposedAction;
  const evidenceResult = dlqTriageEvidenceSchema.safeParse(
    proposedAction && typeof proposedAction === 'object' && 'facts' in proposedAction ? proposedAction.facts : null
  );
  const evidence = evidenceResult.success ? evidenceResult.data : null;
  const approve = useMutation({
    mutationFn: async (reason: string) => {
      const discard = suggestion?.verdict === 'discard';
      const response = await api.post<{
        replayed?: number;
        discarded?: number;
        results: Array<{ reason?: string; historyPending?: boolean }>;
      }>(discard ? '/api/admin/dlq/discard' : '/api/admin/dlq/replay', {
        queueLabel,
        messageIds: [messageId],
        aiSuggestionId: suggestion?.id,
        reason,
      });
      if ((discard ? response.data.discarded : response.data.replayed) !== 1)
        throw new Error('Action did not complete. Refresh and inspect the message and history before acting again.');
      return response.data;
    },
    onSuccess: data => {
      setConfirmOpen(false);
      if (data.results.some(result => result.reason || result.historyPending))
        toast.warning('Action completed with a warning. Inspect DLQ history.');
      else toast.success(suggestion?.verdict === 'discard' ? 'Message discarded.' : 'Message replayed.');
    },
    onError: error => toast.error(error.message),
    onSettled: () => {
      setConfirmOpen(false);
      return client.invalidateQueries({ queryKey: ['admin', 'dlq'] });
    },
  });
  if (!suggestion) return null;
  return (
    <Stack gap={1} data-testid={`dlq-triage-${messageId}`} onClick={event => event.stopPropagation()}>
      <Typography level="body-xs">
        {suggestion.verdict}: {suggestion.reasons[0]?.text}
      </Typography>
      <Typography level="body-xs">
        {suggestion.actionClass} - {suggestion.status === 'accepted' ? 'Authorized' : suggestion.status}
      </Typography>
      {suggestion.status === 'accepted' && (
        <Typography level="body-xs" data-testid={`dlq-triage-execution-${messageId}`}>
          {execution
            ? execution.status === 'success'
              ? 'Replay send acknowledged. Consumer outcome unknown.'
              : execution.status === 'discarded'
                ? 'Discard deletion acknowledged.'
                : execution.status === 'failed'
                  ? 'Operation request failed; inspect history before retrying.'
                  : execution.status === 'skipped'
                    ? 'Operation skipped; no replay was sent.'
                    : 'Operation started; execution outcome unconfirmed.'
            : 'Execution outcome unconfirmed. Authorization does not prove replay, discard or consumer success.'}
          {execution?.hasWarning ? ' Operation warning recorded; inspect history before acting again.' : ''}
          {execution ? ` Recorded ${execution.recordedAt}.` : ' Inspect DLQ history before acting again.'}
        </Typography>
      )}
      {evidence && (
        <details data-testid={`dlq-triage-evidence-${messageId}`}>
          <summary>Review partial evidence</summary>
          <Typography level="body-xs">
            Partial SQS sample; not an inventory. Failure: {evidence.failureSource}. Consumer version:{' '}
            {evidence.consumerVersion}. Fix verification: unavailable.
          </Typography>
          <Typography level="body-xs">
            Entity context: {evidence.entityContext}. Consumer logs: {evidence.logFallback.status} (
            {evidence.logFallback.sampledEvents} sampled events; not proof of a failure or fix).
          </Typography>
          <Typography level="body-xs">
            Expiry: {evidence.expiry.status}
            {evidence.expiry.estimatedExpiresAt ? ` (${evidence.expiry.estimatedExpiresAt})` : ''}.{' '}
            {evidence.expiry.explanation}
          </Typography>
          <Typography level="body-xs">
            Registered owner: {evidence.owner ?? 'unavailable'}.
            {evidence.expiry.status === 'within-24-hours'
              ? ' Request owner review before estimated expiry; no fix has been verified.'
              : ''}
          </Typography>
          {evidence.issueDraft && (
            <details data-testid={`dlq-triage-draft-${messageId}`}>
              <summary>Review sanitized issue draft</summary>
              <Typography level="body-xs">{evidence.issueDraft.title}</Typography>
              <Typography level="body-xs">{evidence.issueDraft.body}</Typography>
            </details>
          )}
        </details>
      )}
      {suggestion.status === 'pending' && (
        <AdminPermissionAction requirement="settings:manage">
          {disabled => (
            <Stack direction="row" gap={1}>
              {(suggestion.verdict === 'replay' || suggestion.verdict === 'discard') && (
                <Button
                  size="sm"
                  disabled={disabled || approve.isPending || dismiss.isPending}
                  data-testid={`dlq-triage-approve-${messageId}`}
                  onClick={() => setConfirmOpen(true)}
                >
                  Approve
                </Button>
              )}
              <Button
                size="sm"
                variant="plain"
                disabled={disabled || dismiss.isPending || approve.isPending}
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
      <ActionDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={suggestion.verdict === 'discard' ? 'Discard recommended message' : 'Replay recommended message'}
        description={`${suggestion.reasons[0]?.text ?? ''} ${suggestion.verdict === 'discard' ? 'Removes the message from the queue; its body is retained in history for 30 days.' : 'Sends the job to its consumer; side effects cannot be undone.'}`}
        confirmLabel={suggestion.verdict === 'discard' ? 'Discard message' : 'Replay message'}
        tone={suggestion.verdict === 'discard' ? 'danger' : 'neutral'}
        reasonPresets={[]}
        pending={approve.isPending}
        onConfirm={async reason => {
          await approve.mutateAsync(reason);
        }}
        data-testid={`dlq-triage-confirm-${messageId}`}
      />
    </Stack>
  );
}
