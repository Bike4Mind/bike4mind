import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Sheet, Stack } from '@mui/joy';
import { useSearch } from '@tanstack/react-router';
import { DLQ_QUEUE_PARAM } from '@bike4mind/common';
import {
  applyDlqCountCeiling,
  useDlqAllMessages,
  useDlqCountCeilings,
  useDlqQueues,
  type DlqListedMessage,
  type DlqQueueInfo,
  type DlqQueueListing,
} from '@client/app/hooks/data/dlqManagement';
import {
  AdminPageHeader,
  EmptyState,
  ErrorState,
  LoadingState,
  SegmentedControl,
  StatStrip,
  StatTile,
} from '@client/app/components/admin/shared';
import { useAdminListUrlState } from '@client/app/components/admin/shared/useAdminListUrlState';
import { ADMIN_REGION_GAP, adminSurface } from '@client/app/components/admin/shared/adminStyles';
import { DlqMessageDrawer } from './DlqMessageDrawer';
import { DlqHistoryView } from './DlqHistoryView';
import { DlqMessagesTable } from './DlqMessagesTable';
import { DlqGroupsTable } from './DlqGroupsTable';
import { DLQ_SEARCH_KEYS } from './dlqSearch';

type DlqViewMode = 'groups' | 'messages';
const VIEW_OPTIONS = [
  { value: 'groups', label: 'By failure' },
  { value: 'messages', label: 'All messages' },
] as const;

/** Messages the listing could not reach: SQS only samples a queue, and a queue's read can fail. */
function listingGaps(queues: readonly DlqQueueListing[]) {
  const failed = queues.filter(queue => queue.failed).length;
  const unlisted = queues.reduce(
    (sum, queue) => sum + (queue.failed ? 0 : Math.max(queue.approximateMessageCount - queue.listed, 0)),
    0
  );
  return { failed, unlisted };
}

/** Stands in for the totals when every queue reports zero messages, visible or in flight. */
const AllClear: React.FC<{ checkedAt: number; onCheckAgain: () => void }> = ({ checkedAt, onCheckAgain }) => (
  <Sheet variant="outlined" sx={{ ...adminSurface, borderRadius: 'lg' }} data-testid="dlq-all-clear">
    <EmptyState
      title="No dead letters"
      description={`Every queue listed here is empty, so there is nothing to replay. Last checked ${new Date(checkedAt).toLocaleTimeString()}.`}
      action={
        <Button size="sm" variant="outlined" color="neutral" onClick={onCheckAgain} data-testid="dlq-all-clear-refresh">
          Check again
        </Button>
      }
    />
  </Sheet>
);

const isOnStage = (queue: DlqQueueInfo) => queue.deployed !== false;

const DlqReplayTab: React.FC = () => {
  const [openMessage, setOpenMessage] = useState<DlqListedMessage | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [listState, setListState] = useAdminListUrlState(DLQ_SEARCH_KEYS);
  const { data: ceilings } = useDlqCountCeilings();

  const {
    data: serverQueues,
    isLoading: queuesLoading,
    isError: queuesError,
    dataUpdatedAt: queuesCheckedAt,
    refetch: refetchQueues,
  } = useDlqQueues();
  const listing = useDlqAllMessages();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const queueParam = typeof search[DLQ_QUEUE_PARAM] === 'string' ? search[DLQ_QUEUE_PARAM] : null;
  // A link to a queue, a failure group or one message (an alarm, a shared URL) means its messages.
  const [view, setView] = useState<DlqViewMode>(() =>
    queueParam || typeof search.dlqMessage === 'string' || listState.filters.failure || listState.filters.feature
      ? 'messages'
      : 'groups'
  );

  // SQS counts trail a discard by about a minute; cap them at what the discard left meanwhile.
  const queues = useMemo(
    () =>
      serverQueues?.map(queue => ({
        ...queue,
        approximateMessageCount: applyDlqCountCeiling(ceilings, queue.label, queue.approximateMessageCount),
      })),
    [serverQueues, ceilings]
  );

  // Totals and the all-clear cover only queues this stage creates; a queue that exists but could
  // not be read (-1) still counts, so it keeps the all-clear from showing.
  const stageQueues = useMemo(() => queues?.filter(isOnStage) ?? [], [queues]);
  const totalMessages = useMemo(
    () => stageQueues.reduce((sum, queue) => sum + Math.max(queue.approximateMessageCount, 0), 0),
    [stageQueues]
  );
  const queuesWithMessages = useMemo(
    () => stageQueues.filter(queue => queue.approximateMessageCount > 0).length,
    [stageQueues]
  );
  // A failed background refetch keeps the last good data, so an error must not read as all clear.
  const allClear =
    !queuesError &&
    stageQueues.length > 0 &&
    stageQueues.every(queue => queue.approximateMessageCount === 0 && queue.approximateNotVisibleCount <= 0);

  // An alarm deep-links to one queue (adminDlqReplayPath); explain a label this page cannot show.
  const linkedQueue = queueParam ? queues?.find(queue => queue.label === queueParam) : undefined;
  const unknownQueue = queueParam && queues && !(linkedQueue && isOnStage(linkedQueue)) ? queueParam : null;
  const gaps = listingGaps(
    (listing.data?.queues ?? []).map(queue => ({
      ...queue,
      approximateMessageCount: applyDlqCountCeiling(ceilings, queue.label, queue.approximateMessageCount),
    }))
  );
  const notOnStage = (queues?.length ?? 0) - stageQueues.length;
  const unreadable = stageQueues.filter(queue => queue.approximateMessageCount < 0).length;
  const messages = listing.data?.messages ?? [];
  const openedLink = useRef<string | null>(null);
  useEffect(() => {
    if (typeof search.dlqMessage !== 'string') return;
    const link = `${queueParam}:${search.dlqMessage}`;
    if (openedLink.current === link) return;
    const message = listing.data?.messages.find(
      message => message.messageId === search.dlqMessage && (!queueParam || message.queueLabel === queueParam)
    );
    if (message) {
      setOpenMessage(message);
      openedLink.current = link;
    }
  }, [listing.data, search.dlqMessage, queueParam]);

  return (
    <Stack gap={ADMIN_REGION_GAP}>
      <AdminPageHeader
        title="Dead letters"
        description="Every failed message across the dead-letter queues, newest first. Select messages to replay them to their source queue or discard them."
        actions={
          <>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              aria-pressed={showHistory}
              onClick={() => setShowHistory(previous => !previous)}
              data-testid="dlq-toggle-history"
            >
              {showHistory ? 'Hide replay history' : 'Show replay history'}
            </Button>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              onClick={() => {
                void refetchQueues();
                void listing.refetch();
              }}
              data-testid="dlq-refresh"
            >
              Refresh
            </Button>
          </>
        }
      />

      {queuesLoading ? (
        <LoadingState label="Loading dead-letter queues" />
      ) : queuesError ? (
        <ErrorState message="The dead-letter queues failed to load." onRetry={() => void refetchQueues()} />
      ) : allClear ? (
        <AllClear
          checkedAt={queuesCheckedAt}
          onCheckAgain={() => {
            void refetchQueues();
            void listing.refetch();
          }}
        />
      ) : (
        <StatStrip aria-label="Dead-letter queue totals">
          <StatTile
            label="Dead-letter queues"
            help="Queues this stage creates. The rest of the registry are stage-gated queues (for example scheduled jobs) that this stage does not create."
            value={<span data-testid="dlq-stats-total">{stageQueues.length.toLocaleString()}</span>}
            comparison={
              <span data-testid="dlq-stats-registry">
                {[
                  `of ${(queues?.length ?? 0).toLocaleString()} registered`,
                  notOnStage > 0 && `${notOnStage.toLocaleString()} not on this stage`,
                  unreadable > 0 && `${unreadable.toLocaleString()} unreadable`,
                ]
                  .filter(Boolean)
                  .join('; ')}
              </span>
            }
          />
          <StatTile
            label="Queues with messages"
            value={<span data-testid="dlq-stats-with-messages">{queuesWithMessages.toLocaleString()}</span>}
          />
          <StatTile
            label="Failed messages"
            value={<span data-testid="dlq-stats-failed">{totalMessages.toLocaleString()}</span>}
          />
        </StatStrip>
      )}

      {unknownQueue && (
        <Alert color="neutral" variant="soft" data-testid="dlq-unknown-queue">
          {linkedQueue
            ? `The ${linkedQueue.displayName} queue is not created on this stage, so there is nothing to view here.`
            : `The ${unknownQueue} queue is not listed on this page yet, so it cannot be viewed or replayed here. Check it in the AWS console.`}
        </Alert>
      )}

      {(gaps.unlisted > 0 || gaps.failed > 0) && (
        <Alert color="neutral" data-testid="dlq-listing-partial">
          {[
            gaps.unlisted > 0 &&
              `About ${gaps.unlisted.toLocaleString()} more messages are not listed: SQS returns a sample of each queue. Replay or discard these, then Refresh to load more.`,
            gaps.failed > 0 && `${gaps.failed.toLocaleString()} queues could not be read.`,
          ]
            .filter(Boolean)
            .join(' ')}
        </Alert>
      )}

      {messages.some(message => message.failureLookupFailed) && (
        <Alert color="warning" data-testid="dlq-failure-lookup-warning">
          Failure details are temporarily unavailable for some queues. Their messages are still shown.
        </Alert>
      )}

      {!allClear && (
        <SegmentedControl
          options={VIEW_OPTIONS}
          value={view}
          onChange={setView}
          aria-label="Dead-letter view"
          data-testid="dlq-view"
        />
      )}

      {!allClear && view === 'groups' && (
        <DlqGroupsTable
          messages={messages}
          queues={queues ?? []}
          loading={listing.isLoading}
          error={listing.isError ? 'Dead-letter messages failed to load.' : undefined}
          onRetry={() => void listing.refetch()}
          onShowMessages={group => {
            setListState({
              filters: {
                feature: '',
                queue: group.queueLabel,
                failure: group.discardable ? group.signature : '',
              },
            });
            setView('messages');
          }}
        />
      )}

      {!allClear && view === 'messages' && (
        <DlqMessagesTable
          messages={messages}
          queues={queues ?? []}
          loading={listing.isLoading}
          error={listing.isError ? 'Dead-letter messages failed to load.' : undefined}
          onRetry={() => void listing.refetch()}
          onOpen={setOpenMessage}
        />
      )}

      {showHistory && <DlqHistoryView queues={queues ?? []} />}

      <DlqMessageDrawer
        message={openMessage}
        queue={queues?.find(queue => queue.label === openMessage?.queueLabel)}
        open={openMessage !== null}
        onClose={() => setOpenMessage(null)}
      />
    </Stack>
  );
};

export default DlqReplayTab;
