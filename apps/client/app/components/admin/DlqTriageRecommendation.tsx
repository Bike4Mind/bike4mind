import { Accordion, AccordionDetails, AccordionSummary, Button, Stack, Typography } from '@mui/joy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  dlqTriageEvidenceSchema,
  type AdminAiSuggestionItem,
  type DlqTriageEvidence,
  type DlqTriageExecution,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { AdminPermissionAction } from './shared/MissingPermission';
import { useState } from 'react';
import { ActionDialog } from './shared/ActionDialog';
import { formatUtc, RelativeTime } from './shared/EntityHeader';
import { toast } from 'sonner';

const EXECUTION_TEXT: Record<DlqTriageExecution['status'], string> = {
  success: 'Replay send acknowledged. Consumer outcome unknown.',
  discarded: 'Discard deletion acknowledged.',
  failed: 'Operation request failed; inspect history before retrying.',
  skipped: 'Operation skipped; no replay was sent.',
  pending: 'Operation started; execution outcome unconfirmed.',
};
const FAILURE_SOURCE_LABEL: Record<DlqTriageEvidence['failureSource'], string> = {
  recorded: 'Recorded',
  unavailable: 'Unavailable',
};
const ENTITY_CONTEXT_LABEL: Record<DlqTriageEvidence['entityContext'], string> = {
  'present-id-withheld': 'Present (ID withheld)',
  unavailable: 'Unavailable',
};
const LOG_FALLBACK_LABEL: Record<DlqTriageEvidence['logFallback']['status'], string> = {
  'not-needed': 'Not needed',
  'sampled-matches': 'Matches in sampled logs',
  'no-sampled-match': 'No match in sampled logs',
  unavailable: 'Unavailable',
};
const EXPIRY_LABEL: Record<DlqTriageEvidence['expiry']['status'], string> = {
  'within-24-hours': 'Within 24 hours',
  'outside-24-hours': 'More than 24 hours away',
  elapsed: 'Already elapsed',
  unavailable: 'Unavailable',
};

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
            ? EXECUTION_TEXT[execution.status]
            : 'Execution outcome unconfirmed. Authorization does not prove replay, discard or consumer success.'}
          {execution?.hasWarning ? ' Operation warning recorded; inspect history before acting again.' : ''}
          {execution ? (
            <>
              {' '}
              <RelativeTime prefix="Recorded" at={execution.recordedAt} />.
            </>
          ) : (
            ' Inspect DLQ history before acting again.'
          )}
        </Typography>
      )}
      {evidence && (
        <Accordion data-testid={`dlq-triage-evidence-${messageId}`}>
          <AccordionSummary>Review partial evidence</AccordionSummary>
          <AccordionDetails>
            <Typography level="body-xs">
              Partial SQS sample; not an inventory. Failure: {FAILURE_SOURCE_LABEL[evidence.failureSource]}. Consumer
              version: {evidence.consumerVersion}. Fix verification: unavailable.
            </Typography>
            <Typography level="body-xs">
              Entity context: {ENTITY_CONTEXT_LABEL[evidence.entityContext]}. Consumer logs:{' '}
              {LOG_FALLBACK_LABEL[evidence.logFallback.status]} ({evidence.logFallback.sampledEvents} sampled events;
              not proof of a failure or fix).
            </Typography>
            <Typography level="body-xs">
              Expiry: {EXPIRY_LABEL[evidence.expiry.status]}
              {evidence.expiry.estimatedExpiresAt
                ? ` (${formatUtc(new Date(evidence.expiry.estimatedExpiresAt))})`
                : ''}
              . {evidence.expiry.explanation}
            </Typography>
            <Typography level="body-xs">
              Registered owner: {evidence.owner ?? 'unavailable'}.
              {evidence.expiry.status === 'within-24-hours'
                ? ' Request owner review before estimated expiry; no fix has been verified.'
                : ''}
            </Typography>
            {evidence.issueDraft && (
              <Accordion data-testid={`dlq-triage-draft-${messageId}`}>
                <AccordionSummary>Review sanitized issue draft</AccordionSummary>
                <AccordionDetails>
                  <Typography level="body-xs">{evidence.issueDraft.title}</Typography>
                  <Typography level="body-xs">{evidence.issueDraft.body}</Typography>
                </AccordionDetails>
              </Accordion>
            )}
          </AccordionDetails>
        </Accordion>
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
