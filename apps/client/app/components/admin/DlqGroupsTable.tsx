import React, { useMemo, useRef, useState } from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { toast } from 'sonner';
import {
  useDlqGroupDiscard,
  type DlqGroupDiscardOutcome,
  type DlqListedMessage,
  type DlqQueueInfo,
} from '@client/app/hooks/data/dlqManagement';
import { DataTable, EmptyState, StatusChip, type DataColumn } from '@client/app/components/admin/shared';
import { ActionDialog } from './shared/ActionDialog';
import { AdminPermissionAction } from './shared/MissingPermission';
import { ADMIN_REASON_PRESETS } from './shared/adminReason';
import { FailureChip, failureText } from './DlqMessageDrawer';
import { defaultDiscardReason, groupDlqRows, rememberDiscardReason, toDlqRows, type DlqGroup } from './dlqGroups';
import { formatDuration } from './dlqExpiry';
import { DLQ_COUNT_LAG_NOTE } from './DlqMessagesTable';

const seenAgo = (ms: number | null) => (ms === null ? 'N/A' : `${formatDuration(Date.now() - ms)} ago`);

const GROUP_COLUMNS: readonly DataColumn<DlqGroup>[] = [
  {
    id: 'feature',
    label: 'Feature',
    width: '14rem',
    render: group => (
      <Stack sx={{ minWidth: 0 }}>
        <Typography level="body-sm" noWrap sx={{ color: 'admin.ink' }}>
          {group.feature}
        </Typography>
        <Typography level="body-xs" noWrap sx={{ color: 'admin.inkMuted' }}>
          {group.queue?.displayName ?? group.queueLabel}
        </Typography>
      </Stack>
    ),
  },
  {
    id: 'failure',
    label: 'Failure',
    render: group => (
      <Stack gap={0.5} sx={{ minWidth: 0 }} data-testid={`dlq-group-failure-${group.id}`}>
        <Typography level="body-xs" noWrap>
          {failureText(group.failure)}
        </Typography>
        <span>
          <FailureChip
            failure={group.failure}
            categoryTestId={`dlq-group-category-${group.id}`}
            sourceTestId={`dlq-group-source-${group.id}`}
          />
        </span>
      </Stack>
    ),
  },
  {
    id: 'count',
    label: 'Listed',
    width: '5.5rem',
    numeric: true,
    help: 'Messages of this group in the listing. SQS returns a sample of each queue, so a queue can hold more.',
    render: group => <span data-testid={`dlq-group-count-${group.id}`}>{group.messageIds.length}</span>,
  },
  {
    id: 'seen',
    label: 'First / last seen',
    width: '10rem',
    render: group => (
      <Stack gap={0.5}>
        <Typography level="body-xs">
          {seenAgo(group.firstSentMs)} / {seenAgo(group.lastSentMs)}
        </Typography>
        <span>
          <StatusChip
            tone={group.stillArriving ? 'warn' : 'neutral'}
            label={group.stillArriving ? 'Still arriving' : 'Stopped'}
            data-testid={`dlq-group-burst-${group.id}`}
          />
        </span>
      </Stack>
    ),
  },
  {
    id: 'recommendation',
    label: 'Next step',
    width: '12rem',
    help: 'Shown when every listed message in the group has the same advisory next step.',
    render: group =>
      group.recommendation ? (
        <StatusChip tone="neutral" label={group.recommendation.label} />
      ) : (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          Varies; open the messages
        </Typography>
      ),
  },
];

function summarizeGroupDiscard(outcome: DlqGroupDiscardOutcome) {
  const problems = [
    outcome.failed && `${outcome.failed} failed`,
    outcome.stopped === 'lookup_failed' && 'stopped because failure details were unavailable',
    outcome.stopped === 'no_progress' && 'no more matching messages were found this time',
    outcome.stopped === 'max_rounds' && 'stopped at the per-run limit; run it again for the rest',
    outcome.stopped === 'cancelled' && 'stopped on request',
    outcome.stopped === 'error' && 'stopped by an error',
  ].filter(Boolean);
  const message = [
    `Discarded ${outcome.discarded.toLocaleString()} messages${outcome.complete ? '; none of this group is left' : ''}${problems.length ? `; ${problems.join(', ')}` : ''}.`,
    problems.length && outcome.firstFailure ? outcome.firstFailure : null,
    outcome.discarded > 0 ? DLQ_COUNT_LAG_NOTE : null,
  ]
    .filter(Boolean)
    .join(' ');
  if (outcome.discarded === 0) toast.error(message);
  else if (problems.length) toast.warning(message);
  else toast.success(message);
  if (outcome.historyPending > 0) {
    toast.warning(
      'History outcome is unconfirmed for some messages; their bodies are kept for 30 days for manual recovery.'
    );
  }
}

/**
 * Dead letters grouped by queue and failure. "Discard all" matches the group on the server, so it also
 * reaches messages of the group that the listing's sample did not include.
 */
export const DlqGroupsTable: React.FC<{
  messages: readonly DlqListedMessage[];
  queues: readonly DlqQueueInfo[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  onShowMessages: (group: DlqGroup) => void;
}> = ({ messages, queues, loading, error, onRetry, onShowMessages }) => {
  const [target, setTarget] = useState<DlqGroup | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const cancelled = useRef(false);
  const groupDiscard = useDlqGroupDiscard();
  const groups = useMemo(() => groupDlqRows(toDlqRows(messages, queues)), [messages, queues]);

  const confirm = async (reason: string) => {
    if (!target) return;
    rememberDiscardReason(reason);
    cancelled.current = false;
    setProgress(0);
    try {
      const outcome = await groupDiscard.mutateAsync({
        queueLabel: target.queueLabel,
        failureSignature: target.signature,
        reason,
        onProgress: setProgress,
        isCancelled: () => cancelled.current,
      });
      summarizeGroupDiscard(outcome);
      setTarget(null);
    } catch (failure) {
      toast.error(`The discard failed: ${failure instanceof Error ? failure.message : 'Unknown error'}`);
      throw failure;
    } finally {
      setProgress(null);
    }
  };

  const close = () => {
    // Stops the run after the request in flight; what it already discarded stays discarded.
    if (groupDiscard.isPending) cancelled.current = true;
    else setTarget(null);
  };

  return (
    <>
      <DataTable
        rows={groups}
        columns={GROUP_COLUMNS}
        getRowId={group => group.id}
        label="Dead letters by failure"
        loading={loading}
        error={error}
        onRetry={onRetry}
        empty={<EmptyState title="No dead letters" description="Every dead-letter queue is empty." action={null} />}
        onRowActivate={onShowMessages}
        rowTestId={group => `dlq-group-row-${group.id}`}
        testId="dlq-groups-table"
        minWidth="60rem"
        actionsWidth="13rem"
        rowActions={group => (
          <Stack direction="row" gap={0.5}>
            <Button
              size="sm"
              variant="plain"
              onClick={() => onShowMessages(group)}
              data-testid={`dlq-group-show-${group.id}`}
            >
              Messages
            </Button>
            <AdminPermissionAction
              requirement="settings:manage"
              blockedReason={group.discardable ? null : 'Failure details are unavailable for this message'}
            >
              {disabled => (
                <Button
                  size="sm"
                  variant="outlined"
                  color="danger"
                  startDecorator={<DeleteOutlineIcon />}
                  disabled={disabled || groupDiscard.isPending}
                  onClick={() => setTarget(group)}
                  data-testid={`dlq-group-discard-${group.id}`}
                >
                  Discard all
                </Button>
              )}
            </AdminPermissionAction>
          </Stack>
        )}
      />

      <ActionDialog
        open={target !== null}
        onClose={close}
        cancelStopsWrite
        title={`Discard every ${target?.queue?.displayName ?? target?.queueLabel} message with this failure?`}
        description="Every message in this queue that failed this way is removed, including any the listing did not show. Other messages are left in place. It cannot be undone from this page; each message body is kept for 30 days for manual recovery."
        reasonPresets={ADMIN_REASON_PRESETS.dlqDiscard}
        initialReason={defaultDiscardReason([target?.recommendation])}
        formKey={target?.id}
        confirmLabel="Discard all matching"
        tone="danger"
        pending={groupDiscard.isPending}
        onConfirm={confirm}
        data-testid="dlq-group-discard-dialog"
      >
        {target && (
          <Stack gap={0.5}>
            <Typography level="body-sm" sx={{ color: 'admin.ink' }} data-testid="dlq-group-discard-failure">
              {failureText(target.failure)}
            </Typography>
            <Typography level="body-xs">
              {target.messageIds.length.toLocaleString()} listed; the queue may hold more.
            </Typography>
          </Stack>
        )}
        {progress !== null && (
          <Typography level="body-sm" role="status" data-testid="dlq-group-discard-progress">
            Discarding: {progress.toLocaleString()} so far. Cancel stops after the current batch.
          </Typography>
        )}
      </ActionDialog>
    </>
  );
};
