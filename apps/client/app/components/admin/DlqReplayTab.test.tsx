import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import DlqReplayTab from './DlqReplayTab';
vi.mock('./DlqTriageRecommendation', () => ({ DlqTriageRecommendation: () => null }));

type TestMessage = {
  queueLabel: string;
  messageId: string;
  body: string;
  failureSignature?: string;
  entity: { type: string; id: string } | null;
  sentTimestamp: string;
  approximateReceiveCount: string;
  failureLookupFailed?: boolean;
  failure?: {
    errorMessage: string;
    category: 'timeout' | 'unknown';
    source: 'recorded' | 'attributes';
    errorCode?: string;
  };
  logsUrl?: string | null;
  logsScope?: 'request' | 'window';
  recommendation?: { action: 'replay' | 'inspect' | 'discard'; label: string; basis: string };
};

const state = vi.hoisted(() => ({
  retentionSeconds: undefined as number | undefined,
  messages: [] as TestMessage[],
  listings: [] as Array<{ label: string; approximateMessageCount: number; listed: number; failed: boolean }>,
  history: [] as Array<{
    id: string;
    queueLabel: string;
    messageId: string;
    sourceQueue: string;
    status: 'success' | 'failed' | 'skipped' | 'discarded' | 'pending';
    operation?: 'replay' | 'discard';
    errorMessage?: string;
    reason?: string;
    replayedBy: string;
    replayedByName: string;
    createdAt: string;
  }>,
  queues: [] as Array<Record<string, unknown>>,
  queuesError: false,
}));

const h = vi.hoisted(() => ({
  discard: vi.fn(),
  groupDiscard: vi.fn(),
  groupDiscardPending: false,
  ceilings: {} as Record<string, { ceiling: number; until: number }>,
  replay: vi.fn(),
  user: null as null | { isAdmin?: boolean; adminPermissions?: string[] },
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
  refetchQueues: vi.fn(),
}));

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: h.user }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@tanstack/react-router', () => ({ useSearch: () => h.search, useNavigate: () => h.navigate }));
vi.mock('@client/app/hooks/data/dlqManagement', async importOriginal => ({
  DLQ_SIGNATURE_UNAVAILABLE: 'unavailable',
  applyDlqCountCeiling: (await importOriginal<typeof import('@client/app/hooks/data/dlqManagement')>())
    .applyDlqCountCeiling,
  useDlqCountCeilings: () => ({ data: h.ceilings }),
  useDlqGroupDiscard: () => ({ mutateAsync: h.groupDiscard, isPending: h.groupDiscardPending }),
  useDlqQueues: () => ({
    data: state.queues.map(q => ({ messageRetentionSeconds: state.retentionSeconds, ...q })),
    isLoading: false,
    isError: state.queuesError,
    dataUpdatedAt: 0,
    refetch: h.refetchQueues,
  }),
  useDlqAllMessages: () => ({
    data: { messages: state.messages, queues: state.listings },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useDlqReplay: () => ({ mutateAsync: h.replay, isPending: false }),
  useDlqDiscard: () => ({ mutateAsync: h.discard, isPending: false }),
  useDlqHistory: () => ({
    data: { pages: [{ history: state.history, nextCursor: null }] },
    isLoading: false,
    isError: false,
  }),
}));

const BILLING_QUEUE = {
  label: 'billing',
  displayName: 'Billing Events',
  application: 'Billing',
  owner: 'Billing',
  description: 'Applies Stripe events to subscriptions.',
  replay: 'unsafe',
  replayNote: 'Can resend a receipt.',
  hasReplayDestination: true,
  approximateMessageCount: 2,
  approximateNotVisibleCount: 0,
};
const FILES_QUEUE = {
  label: 'files',
  displayName: 'FabFile Vectorize',
  application: 'FabFileProcessing',
  owner: 'Knowledge files',
  replay: 'side-effects',
  hasReplayDestination: true,
  approximateMessageCount: 1,
  approximateNotVisibleCount: 0,
};
const CRON_QUEUE = {
  label: 'cron',
  displayName: 'Spend Monitor',
  application: 'Ops',
  owner: 'Platform ops',
  hasReplayDestination: false,
  approximateMessageCount: 1,
  approximateNotVisibleCount: 0,
};

const HOUR = 3600 * 1000;
const message = (queueLabel: string, messageId: string, ageHours: number, extra: Partial<TestMessage> = {}) => ({
  queueLabel,
  messageId,
  body: '{}',
  entity: null,
  sentTimestamp: String(Date.now() - ageHours * HOUR),
  approximateReceiveCount: '1',
  ...extra,
});

const theme = extendTheme({ ...getThemeConfig() });

/** Renders the tab on the All messages view unless `view` says otherwise; By failure is the default. */
function renderTab({ view = 'messages' }: { view?: 'messages' | 'groups' } = {}) {
  const result = render(
    <CssVarsProvider theme={theme}>
      <DlqReplayTab />
    </CssVarsProvider>
  );
  const toggle = screen.queryByTestId('dlq-view-messages');
  if (view === 'messages' && toggle && toggle.getAttribute('aria-pressed') !== 'true') fireEvent.click(toggle);
  return result;
}

const rowIds = () =>
  within(screen.getByTestId('dlq-messages-table'))
    .getAllByRole('row')
    .map(row => row.getAttribute('data-row-id'))
    .filter(Boolean);

const selectRow = (id: string) =>
  fireEvent.click(within(screen.getByTestId(`admin-table-select-${id}`)).getByRole('checkbox'));

const manager = { isAdmin: false, adminPermissions: ['settings:manage'] };

const REPLAY_REASON = 'Reviewed failure and replay side effects';
const confirmReplay = async () => {
  await userEvent.click(screen.getByTestId('dlq-replay-dialog-reason-input-preset-0'));
  await userEvent.click(screen.getByTestId('dlq-replay-confirm'));
};

beforeEach(() => {
  vi.clearAllMocks();
  h.ceilings = {};
  h.groupDiscardPending = false;
  sessionStorage.clear();
  state.queues = [BILLING_QUEUE, FILES_QUEUE, CRON_QUEUE];
  // Server order: newest first across queues.
  state.messages = [
    message('files', 'f1', 1, { entity: { type: 'File', id: 'file-123' } }),
    message('billing', 'b1', 2, { entity: { type: 'Invoice', id: 'in_456' } }),
    message('cron', 'c1', 3),
    message('billing', 'b2', 4),
  ];
  state.listings = [
    { label: 'billing', approximateMessageCount: 2, listed: 2, failed: false },
    { label: 'files', approximateMessageCount: 1, listed: 1, failed: false },
    { label: 'cron', approximateMessageCount: 1, listed: 1, failed: false },
  ];
  state.history = [];
  state.retentionSeconds = undefined;
  state.queuesError = false;
  h.user = null;
  h.search = {};
  h.replay.mockReset();
  h.discard.mockReset();
});

describe('DlqReplayTab unified table', () => {
  it("lists every queue's messages in one table in the order the server sorted them", () => {
    renderTab();
    expect(rowIds()).toEqual(['f1', 'b1', 'c1', 'b2']);
    expect(screen.queryByRole('combobox', { name: /queue/i })).not.toBeInTheDocument();
  });

  it('shows the feature, queue and entity from the registry describe', () => {
    renderTab();
    const row = within(screen.getByTestId('dlq-message-row-b1'));
    expect(row.getByText('Billing')).toBeTruthy();
    expect(row.getByText('Billing Events')).toBeTruthy();
    expect(screen.getByTestId('dlq-entity-b1')).toHaveTextContent('Invoice');
    expect(screen.getByTestId('dlq-entity-b1')).toHaveTextContent('in_456');
    expect(screen.queryByTestId('dlq-entity-c1')).not.toBeInTheDocument();
  });

  it('falls back to the queue name as the feature for a queue without an owner', () => {
    state.queues = [{ ...FILES_QUEUE, owner: undefined }, BILLING_QUEUE, CRON_QUEUE];
    renderTab();
    expect(within(screen.getByTestId('dlq-message-row-f1')).getAllByText('FabFile Vectorize')).toHaveLength(2);
  });

  it('limits the table to the feature in the URL', () => {
    h.search = { dlqFeature: 'Billing' };
    renderTab();
    expect(rowIds()).toEqual(['b1', 'b2']);
  });

  it('limits the table to the queue in the URL, as the DLQ alarm links it', () => {
    h.search = { dlqQueue: 'files' };
    renderTab();
    expect(rowIds()).toEqual(['f1']);
  });

  it('says how many messages the sampled listing left out', () => {
    state.listings = [
      { label: 'billing', approximateMessageCount: 80, listed: 50, failed: false },
      { label: 'files', approximateMessageCount: 3, listed: 0, failed: true },
    ];
    renderTab();
    expect(screen.getByTestId('dlq-listing-partial')).toHaveTextContent('About 30 more messages are not listed');
    expect(screen.getByTestId('dlq-listing-partial')).toHaveTextContent('1 queues could not be read');
  });

  it('shows no partial notice when every message is listed', () => {
    renderTab();
    expect(screen.queryByTestId('dlq-listing-partial')).not.toBeInTheDocument();
  });

  it('shows an empty state when every queue is empty', () => {
    state.messages = [];
    renderTab();
    expect(screen.getByText('No dead letters')).toBeTruthy();
  });
});

describe('DlqReplayTab bulk replay', () => {
  it('replays exactly the selected messages, grouped by queue', async () => {
    h.user = manager;
    h.replay.mockResolvedValue([
      { messageId: 'b2', queueLabel: 'billing', status: 'replayed' },
      { messageId: 'f1', queueLabel: 'files', status: 'replayed' },
    ]);
    renderTab();
    selectRow('b2');
    selectRow('f1');
    await userEvent.click(screen.getByTestId('dlq-bulk-replay'));
    expect(screen.getByTestId('dlq-replay-groups')).toHaveTextContent('Billing Events: 1');
    expect(screen.getByTestId('dlq-replay-groups')).toHaveTextContent('Unsafe to replay');
    await confirmReplay();
    expect(h.replay).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(h.replay.mock.calls[0][0].messageIdsByQueue)).toEqual({ billing: ['b2'], files: ['f1'] });
    expect(toast.success).toHaveBeenCalledWith('2 of 2 replayed. Queue counts catch up within about a minute.');
  });

  it('selects every message in the filtered feature and replays only those', async () => {
    h.user = manager;
    h.search = { dlqFeature: 'Billing' };
    h.replay.mockResolvedValue([]);
    renderTab();
    await userEvent.click(screen.getByTestId('dlq-select-all-in-scope'));
    expect(screen.getByTestId('admin-bulk-action-bar')).toHaveTextContent('2 selected');
    await userEvent.click(screen.getByTestId('dlq-bulk-replay'));
    await confirmReplay();
    expect([...h.replay.mock.calls[0][0].messageIdsByQueue]).toEqual([['billing', ['b1', 'b2']]]);
  });

  it('offers no select-all without a feature or queue filter', () => {
    renderTab();
    expect(screen.queryByTestId('dlq-select-all-in-scope')).not.toBeInTheDocument();
  });

  it('leaves messages without a replay destination out of the replay and says so', async () => {
    h.user = manager;
    h.replay.mockResolvedValue([{ messageId: 'b1', queueLabel: 'billing', status: 'replayed' }]);
    renderTab();
    selectRow('b1');
    selectRow('c1');
    expect(screen.getByTestId('dlq-bulk-replay')).toHaveTextContent('Replay 1');
    await userEvent.click(screen.getByTestId('dlq-bulk-replay'));
    expect(screen.getByTestId('dlq-replay-excluded')).toHaveTextContent('1 selected messages have no replay');
    await confirmReplay();
    expect([...h.replay.mock.calls[0][0].messageIdsByQueue]).toEqual([['billing', ['b1']]]);
  });

  it('disables replay when no selected message can be replayed', () => {
    h.user = manager;
    renderTab();
    selectRow('c1');
    expect(screen.getByTestId('dlq-bulk-replay')).toBeDisabled();
  });

  it('reports partial outcomes', async () => {
    h.user = manager;
    h.replay.mockResolvedValue([
      { messageId: 'b1', queueLabel: 'billing', status: 'replayed' },
      { messageId: 'b2', queueLabel: 'billing', status: 'notFound' },
    ]);
    renderTab();
    selectRow('b1');
    selectRow('b2');
    await userEvent.click(screen.getByTestId('dlq-bulk-replay'));
    await confirmReplay();
    expect(toast.warning).toHaveBeenCalledWith(
      '1 of 2 replayed; 1 not found in the queue. Queue counts catch up within about a minute.'
    );
  });

  it('requires a reason when any selected queue is not safe to replay, and sends it', async () => {
    h.user = manager;
    h.replay.mockResolvedValue([{ messageId: 'f1', queueLabel: 'files', status: 'replayed' }]);
    renderTab();
    selectRow('f1');
    await userEvent.click(screen.getByTestId('dlq-bulk-replay'));
    expect(screen.getByTestId('dlq-replay-reason-note')).toBeInTheDocument();
    expect(screen.getByTestId('dlq-replay-confirm')).toBeDisabled();
    await confirmReplay();
    expect(h.replay).toHaveBeenCalledWith(expect.objectContaining({ reason: REPLAY_REASON }));
  });

  it('replays safe queues without asking for a reason', async () => {
    h.user = manager;
    state.queues = [BILLING_QUEUE, { ...FILES_QUEUE, replay: 'safe' }, CRON_QUEUE];
    h.replay.mockResolvedValue([{ messageId: 'f1', queueLabel: 'files', status: 'replayed' }]);
    renderTab();
    selectRow('f1');
    await userEvent.click(screen.getByTestId('dlq-bulk-replay'));
    expect(screen.queryByTestId('dlq-replay-reason-note')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('dlq-replay-confirm'));
    expect(h.replay).toHaveBeenCalledWith(expect.objectContaining({ reason: undefined }));
  });

  it('disables bulk actions for a support:read viewer', () => {
    h.user = { isAdmin: false, adminPermissions: ['support:read'] };
    renderTab();
    selectRow('b1');
    expect(screen.getByTestId('dlq-bulk-replay')).toBeDisabled();
    expect(screen.getByTestId('dlq-bulk-discard')).toBeDisabled();
  });
});

describe('DlqReplayTab bulk outcomes', () => {
  it('warns when a replayed message could not be removed from the DLQ', async () => {
    h.user = manager;
    h.replay.mockResolvedValue([
      { messageId: 'b1', queueLabel: 'billing', status: 'replayed', reason: 'Warning: delete from DLQ failed' },
    ]);
    renderTab();
    selectRow('b1');
    await userEvent.click(screen.getByTestId('dlq-bulk-replay'));
    await confirmReplay();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(
      '1 of 1 replayed; 1 replayed but still in the DLQ (do not replay them again). Warning: delete from DLQ failed Queue counts catch up within about a minute.'
    );
  });

  it('acts only on visible rows when the URL filter changes outside the filter bar', async () => {
    h.user = manager;
    h.discard.mockResolvedValue([{ messageId: 'b1', queueLabel: 'billing', status: 'discarded' }]);
    const view = renderTab();
    selectRow('b1');
    selectRow('f1');
    // Back/forward or another alarm link changes the URL without going through the filter bar.
    h.search = { dlqFeature: 'Billing' };
    view.rerender(
      <CssVarsProvider theme={theme}>
        <DlqReplayTab />
      </CssVarsProvider>
    );
    await userEvent.click(screen.getByTestId('dlq-bulk-discard'));
    await userEvent.click(screen.getByTestId('dlq-discard-dialog-reason-input-preset-1'));
    await userEvent.click(screen.getByTestId('dlq-discard-dialog-confirm-btn'));
    expect(Object.fromEntries(h.discard.mock.calls[0][0].messageIdsByQueue)).toEqual({ billing: ['b1'] });
  });

  it('closes the discard dialog when the messages are already gone', async () => {
    h.user = manager;
    h.discard.mockResolvedValue([{ messageId: 'b1', queueLabel: 'billing', status: 'notFound' }]);
    renderTab();
    selectRow('b1');
    await userEvent.click(screen.getByTestId('dlq-bulk-discard'));
    await userEvent.click(screen.getByTestId('dlq-discard-dialog-reason-input-preset-1'));
    await userEvent.click(screen.getByTestId('dlq-discard-dialog-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('dlq-discard-dialog-confirm-btn')).not.toBeInTheDocument());
  });
});

describe('DlqReplayTab all-clear and stage', () => {
  const empty = (queue: Record<string, unknown>) => ({ ...queue, approximateMessageCount: 0 });

  it('replaces the counts and the table with an all-clear card when every queue is empty', async () => {
    state.queues = [empty(BILLING_QUEUE), empty(FILES_QUEUE)];
    state.messages = [];
    renderTab();
    expect(screen.getByTestId('dlq-all-clear')).toBeTruthy();
    expect(screen.queryByTestId('dlq-stats-total')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dlq-messages-table')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('dlq-all-clear-refresh'));
    expect(h.refetchQueues).toHaveBeenCalled();
  });

  it('keeps showing counts while a message is in flight', () => {
    state.queues = [{ ...empty(BILLING_QUEUE), approximateNotVisibleCount: 1 }];
    state.messages = [];
    renderTab();
    expect(screen.queryByTestId('dlq-all-clear')).not.toBeInTheDocument();
  });

  it('shows the load error, not the all-clear, after a failed refetch', () => {
    state.queues = [empty(BILLING_QUEUE)];
    state.queuesError = true;
    renderTab();
    expect(screen.queryByTestId('dlq-all-clear')).not.toBeInTheDocument();
  });

  it('shows the all-clear when every queue this stage creates is empty', () => {
    state.queues = [
      empty(BILLING_QUEUE),
      { ...CRON_QUEUE, deployed: false, approximateMessageCount: -1, approximateNotVisibleCount: -1 },
    ];
    state.messages = [];
    renderTab();
    expect(screen.getByTestId('dlq-all-clear')).toBeTruthy();
  });

  it('counts only queues this stage creates and says what the rest of the registry is', () => {
    state.queues = [
      BILLING_QUEUE,
      { ...FILES_QUEUE, approximateMessageCount: -1 },
      { ...CRON_QUEUE, deployed: false, approximateMessageCount: -1 },
    ];
    state.messages = [message('billing', 'b1', 1)];
    renderTab();
    expect(screen.getByTestId('dlq-stats-total')).toHaveTextContent('2');
    expect(screen.getByTestId('dlq-stats-registry')).toHaveTextContent(
      'of 3 registered; 1 not on this stage; 1 unreadable'
    );
  });

  it('explains a deep link to a queue this stage does not create', () => {
    state.queues = [BILLING_QUEUE, { ...CRON_QUEUE, deployed: false, approximateMessageCount: -1 }];
    h.search = { dlqQueue: 'cron' };
    renderTab();
    expect(screen.getByTestId('dlq-unknown-queue')).toHaveTextContent('not created on this stage');
  });

  it('explains a deep link to a queue the page does not list', () => {
    h.search = { dlqQueue: 'mystery' };
    renderTab();
    expect(screen.getByTestId('dlq-unknown-queue')).toHaveTextContent('mystery queue is not listed');
  });

  it('shows no deep-link notice for a listed queue', () => {
    h.search = { dlqQueue: 'files' };
    renderTab();
    expect(screen.queryByTestId('dlq-unknown-queue')).not.toBeInTheDocument();
  });
});

describe('DlqReplayTab bulk discard', () => {
  it('requires a reason and discards exactly the selected messages', async () => {
    h.user = manager;
    h.discard.mockResolvedValue([
      { messageId: 'b1', queueLabel: 'billing', status: 'discarded' },
      { messageId: 'c1', queueLabel: 'cron', status: 'discarded' },
    ]);
    renderTab();
    selectRow('b1');
    selectRow('c1');
    await userEvent.click(screen.getByTestId('dlq-bulk-discard'));
    expect(screen.getByText(/cannot be undone from this page/i)).toBeTruthy();
    const confirm = screen.getByTestId('dlq-discard-dialog-confirm-btn');
    expect(confirm).toBeDisabled();
    await userEvent.click(screen.getByTestId('dlq-discard-dialog-reason-input-preset-1'));
    await userEvent.click(confirm);
    const { messageIdsByQueue, reason } = h.discard.mock.calls[0][0];
    expect(reason).toBe('Job obsolete');
    expect([...messageIdsByQueue]).toEqual([
      ['billing', ['b1']],
      ['cron', ['c1']],
    ]);
    await waitFor(() => expect(screen.queryByTestId('dlq-discard-dialog-confirm-btn')).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledWith('2 of 2 discarded. Queue counts catch up within about a minute.');
  });

  it('keeps the dialog open when nothing was discarded', async () => {
    h.user = manager;
    h.discard.mockResolvedValue([
      { messageId: 'b1', queueLabel: 'billing', status: 'failed', reason: 'boom', historyPending: true },
    ]);
    renderTab();
    selectRow('b1');
    await userEvent.click(screen.getByTestId('dlq-bulk-discard'));
    await userEvent.click(screen.getByTestId('dlq-discard-dialog-reason-input-preset-1'));
    await userEvent.click(screen.getByTestId('dlq-discard-dialog-confirm-btn'));
    expect(toast.error).toHaveBeenCalledWith('0 of 1 discarded; 1 failed. boom');
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('History outcome is unconfirmed'));
    expect(screen.getByTestId('dlq-discard-dialog-confirm-btn')).toBeInTheDocument();
  });
});

describe('DlqReplayTab message details', () => {
  it('shows the failure reason and category in the row and drawer', async () => {
    state.messages[1].failure = { errorMessage: 'worker timed out', category: 'timeout', source: 'recorded' };
    renderTab();
    expect(screen.getByTestId('dlq-reason-b1')).toHaveTextContent('worker timed out');
    expect(screen.getByTestId('dlq-category-b1')).toHaveTextContent('timeout');
    await userEvent.click(within(screen.getByTestId('dlq-message-row-b1')).getByText('worker timed out'));
    expect(screen.getByTestId('dlq-failure-reason')).toHaveTextContent('worker timed out');
    expect(screen.getByTestId('dlq-failure-category')).toHaveTextContent('timeout');
    expect(screen.queryByTestId('dlq-failure-source-b1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dlq-failure-source')).not.toBeInTheDocument();
  });

  it('shows an attribute-derived failure with its error code and source chip instead of a category', async () => {
    state.messages[1].failure = {
      errorMessage: 'Task timed out',
      category: 'unknown',
      source: 'attributes',
      errorCode: 'Function error',
    };
    renderTab();
    expect(screen.getByTestId('dlq-reason-b1')).toHaveTextContent('Function error: Task timed out');
    expect(screen.getByTestId('dlq-failure-source-b1')).toHaveTextContent('From message attributes');
    expect(screen.queryByTestId('dlq-category-b1')).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByTestId('dlq-message-row-b1')).getByText('Function error: Task timed out'));
    expect(screen.getByTestId('dlq-failure-reason')).toHaveTextContent('Function error: Task timed out');
    expect(screen.getByTestId('dlq-failure-source')).toHaveTextContent('From message attributes');
    expect(screen.queryByTestId('dlq-failure-category')).not.toBeInTheDocument();
  });

  it('shows Unknown with an Unknown category when there is no failure', async () => {
    renderTab();
    expect(screen.getByTestId('dlq-reason-b1')).toHaveTextContent('Unknown');
    expect(screen.getByTestId('dlq-category-b1')).toHaveTextContent('Unknown');
    expect(screen.queryByTestId('dlq-failure-source-b1')).not.toBeInTheDocument();
  });

  it('labels a request-filtered logs link as the request logs', async () => {
    state.messages[1].logsUrl = 'https://logs.example/b1';
    state.messages[1].logsScope = 'request';
    state.messages[3].logsUrl = 'https://logs.example/b2';
    renderTab();
    expect(screen.getByTestId('dlq-logs-b1')).toHaveAttribute('aria-label', 'View request logs');
    expect(screen.getByTestId('dlq-logs-b2')).toHaveAttribute('aria-label', 'View consumer logs');
    await userEvent.click(within(screen.getByTestId('dlq-message-row-b1')).getByText('Billing Events'));
    expect(screen.getByTestId('dlq-drawer-logs')).toHaveTextContent('View request logs');
  });

  it('shows the run time of a scheduled-run dead letter as its entity', () => {
    state.messages[2].entity = { type: 'Scheduled run', id: '2026-01-02T03:00:00.000Z' };
    renderTab();
    expect(screen.getByTestId('dlq-entity-c1')).toHaveTextContent('Scheduled run');
  });

  it('shows Unknown and warns when failure details could not be loaded', () => {
    state.messages[1].failureLookupFailed = true;
    renderTab();
    expect(screen.getByTestId('dlq-failure-lookup-warning')).toBeTruthy();
    expect(screen.getByTestId('dlq-reason-b1')).toHaveTextContent('Unknown');
  });

  it('shows the queue hint and entity in the drawer', async () => {
    renderTab();
    await userEvent.click(within(screen.getByTestId('dlq-message-row-b1')).getByText('Billing Events'));
    expect(screen.getByTestId('dlq-drawer-queue')).toHaveTextContent('Applies Stripe events to subscriptions.');
    expect(screen.getByTestId('dlq-queue-hint-replay')).toHaveTextContent('Unsafe to replay');
    expect(screen.getByTestId('dlq-drawer-entity')).toHaveTextContent('in_456');
  });

  it('links each row to its consumer logs without opening the drawer', async () => {
    state.messages[1].logsUrl = 'https://logs.example/b1';
    renderTab();
    const link = screen.getByTestId('dlq-logs-b1');
    expect(link).toHaveAttribute('href', 'https://logs.example/b1');
    expect(screen.queryByTestId('dlq-logs-b2')).not.toBeInTheDocument();
    link.addEventListener('click', event => event.preventDefault());
    await userEvent.click(link);
    expect(screen.queryByTestId('dlq-drawer-close')).not.toBeInTheDocument();
  });

  it('labels the receive count as including views', () => {
    renderTab();
    expect(screen.getByRole('columnheader', { name: /Receives \(incl\. views\)/ })).toBeTruthy();
  });
});

describe('DlqReplayTab recommendations', () => {
  it('shows the advisory next step and its basis on each row', () => {
    state.messages[0] = {
      ...state.messages[0],
      recommendation: { action: 'replay', label: 'Replay', basis: 'Recorded transient failure: timeout.' },
    };
    renderTab();
    expect(screen.getByTestId('dlq-recommendation-f1')).toHaveTextContent('Replay');
    expect(screen.getByTestId('dlq-recommendation-f1')).toHaveTextContent('Recorded transient failure: timeout.');
    expect(screen.getByTestId('dlq-recommendation-b1')).toHaveTextContent('Inspect first');
  });

  it('shows a discard recommendation for an obsolete job', () => {
    state.messages[2] = {
      ...state.messages[2],
      recommendation: {
        action: 'discard',
        label: 'Job obsolete, discard',
        basis:
          'Scheduled run at 2026-01-02T03:00:00.000Z; the next run, due at 2026-01-02T04:00:00.000Z, is not in this dead-letter queue a day later.',
      },
    };
    renderTab();
    expect(screen.getByTestId('dlq-recommendation-c1')).toHaveTextContent('Job obsolete, discard');
    expect(screen.getByTestId('dlq-recommendation-c1')).toHaveTextContent('is not in this dead-letter queue');
  });
});

describe('DlqReplayTab age and expiry', () => {
  it('shows age and time until expiry under their headers', () => {
    state.retentionSeconds = 4 * 24 * 3600;
    state.messages = [message('billing', 'b1', 10.5)];
    renderTab();
    const headers = within(screen.getByTestId('dlq-messages-table'))
      .getAllByRole('columnheader')
      .map(header => header.textContent);
    const cells = within(screen.getByTestId('dlq-message-row-b1')).getAllByRole('cell');
    expect(cells[headers.indexOf('Age')]).toHaveTextContent('10h 30m');
    expect(cells[headers.indexOf('Expires in')]).toHaveTextContent('3d 13h');
  });

  it('flags a message within 24 hours of expiry', () => {
    state.retentionSeconds = 4 * 24 * 3600;
    state.messages = [message('billing', 'b1', 80.5)];
    renderTab();
    expect(screen.getByTestId('dlq-expires-b1')).toHaveAttribute('data-warn', 'true');
  });

  it('shows N/A for expiry when retention is unknown', () => {
    state.messages = [message('billing', 'b1', 1)];
    renderTab();
    expect(screen.getByTestId('dlq-expires-b1')).toHaveTextContent('N/A');
  });

  it('shows age and expiry in the message drawer', async () => {
    state.retentionSeconds = 4 * 24 * 3600;
    state.messages = [message('billing', 'b1', 10.5)];
    renderTab();
    await userEvent.click(within(screen.getByTestId('dlq-message-row-b1')).getByText('Billing Events'));
    expect(await screen.findByTestId('dlq-drawer-expiry')).toHaveTextContent('10h 30m old, expires in 3d 13h');
  });
});

describe('DlqReplayTab history table', () => {
  it('renders "Feature" and "By" columns with correct data', () => {
    state.history = [
      {
        id: 'log-1',
        queueLabel: 'fabfile-vectorize-dlq',
        messageId: 'msg-abc123def456ghi789',
        sourceQueue: 'FabFile Vectorize',
        status: 'success',
        replayedBy: '64b000000000000000000001',
        replayedByName: 'admin@bike4mind.com',
        createdAt: '2026-11-01T12:00:00.000Z',
      },
      {
        id: 'log-2',
        queueLabel: 'image-gen-dlq',
        messageId: 'msg-xyz789uvw012rst345',
        sourceQueue: 'Image Generation',
        status: 'failed',
        errorMessage: 'Timeout exceeded',
        replayedBy: '64b000000000000000000002',
        replayedByName: 'ops@bike4mind.com',
        createdAt: '2026-11-02T08:00:00.000Z',
      },
    ];

    renderTab();
    fireEvent.click(screen.getByTestId('dlq-toggle-history'));

    const table = screen.getByTestId('dlq-history-table');
    const headers = within(table).getAllByRole('columnheader');
    const headerTexts = headers.map(h => h.textContent);

    expect(headerTexts).toContain('Feature');
    expect(headerTexts).toContain('By');
    expect(headerTexts).not.toContain('Queue');

    expect(within(table).getByText('FabFile Vectorize')).toBeTruthy();
    expect(within(table).getByText('Image Generation')).toBeTruthy();

    expect(screen.getByTestId('dlq-history-by-log-1')).toHaveTextContent('admin@bike4mind.com');
    expect(screen.getByTestId('dlq-history-by-log-2')).toHaveTextContent('ops@bike4mind.com');
  });

  it('does not render a messageBody column', () => {
    state.history = [
      {
        id: 'log-3',
        queueLabel: 'quest-dlq',
        messageId: 'msg-no-body-here',
        sourceQueue: 'Quest Export',
        status: 'skipped',
        replayedBy: '64b000000000000000000001',
        replayedByName: 'admin@bike4mind.com',
        createdAt: '2026-11-03T10:00:00.000Z',
      },
    ];

    renderTab();
    fireEvent.click(screen.getByTestId('dlq-toggle-history'));

    const table = screen.getByTestId('dlq-history-table');
    const headers = within(table).getAllByRole('columnheader');
    const headerTexts = headers.map(h => h.textContent);

    expect(headerTexts).not.toContain('Body');
    expect(headerTexts).not.toContain('Message Body');
  });

  it('distinguishes unconfirmed and failed discards and preserves operational errors beside the reason', () => {
    const base = {
      queueLabel: 'q1',
      sourceQueue: 'Queue One',
      messageId: 'm1',
      replayedBy: 'admin-1',
      replayedByName: 'admin',
      createdAt: '2026-11-03T10:00:00.000Z',
    };
    state.history = [
      { ...base, id: 'pending-1', status: 'pending', operation: 'discard', reason: 'Job obsolete' },
      {
        ...base,
        id: 'failed-1',
        status: 'failed',
        operation: 'discard',
        reason: 'Job obsolete',
        errorMessage: 'expired receipt',
      },
      { ...base, id: 'legacy-1', status: 'failed', errorMessage: 'replay failed' },
    ];
    renderTab();
    fireEvent.click(screen.getByTestId('dlq-toggle-history'));
    expect(
      within(screen.getByTestId('dlq-history-row-pending-1')).getByText('Discard outcome unconfirmed')
    ).toBeTruthy();
    const failed = within(screen.getByTestId('dlq-history-row-failed-1'));
    expect(failed.getByText('Discard request failed')).toBeTruthy();
    expect(failed.getByText(/expired receipt/)).toBeTruthy();
    expect(failed.getByText('Job obsolete')).toBeTruthy();
    expect(within(screen.getByTestId('dlq-history-row-legacy-1')).getAllByText('Failed')).toHaveLength(2);
    expect(screen.getByRole('columnheader', { name: 'Time' })).toBeTruthy();
  });

  it('shows discarded history with its reason', () => {
    state.history = [
      {
        id: 'discard-1',
        queueLabel: 'q1',
        messageId: 'm1',
        sourceQueue: 'Queue One',
        status: 'discarded',
        reason: 'Job obsolete',
        replayedBy: 'admin-1',
        replayedByName: 'admin',
        createdAt: '2026-11-03T10:00:00.000Z',
      },
    ];
    renderTab();
    fireEvent.click(screen.getByTestId('dlq-toggle-history'));
    expect(within(screen.getByTestId('dlq-history-row-discard-1')).getAllByText('Discarded')).toHaveLength(2);
    expect(screen.getByText('Job obsolete')).toBeTruthy();
  });
});

const TIMEOUT = { errorMessage: 'Task timed out', category: 'unknown' as const, source: 'attributes' as const };
const OBSOLETE = { action: 'discard' as const, label: 'Job obsolete, discard', basis: 'Superseded by a later run.' };
const SIG = 'a'.repeat(16);

const groupedMessages = () => [
  message('cron', 'c1', 1, { failureSignature: SIG, failure: TIMEOUT, recommendation: OBSOLETE }),
  message('cron', 'c2', 2, { failureSignature: SIG, failure: TIMEOUT, recommendation: OBSOLETE }),
  message('cron', 'c3', 3, { failureSignature: SIG, failure: TIMEOUT, recommendation: OBSOLETE }),
  message('billing', 'b1', 4, { failureSignature: 'b'.repeat(16) }),
];

describe('DlqReplayTab grouped by failure', () => {
  beforeEach(() => {
    state.messages = groupedMessages();
    h.user = manager;
  });

  it('opens on one row per queue and failure, with its count and burst state', () => {
    renderTab({ view: 'groups' });
    expect(screen.getByTestId('dlq-view-groups')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('dlq-messages-table')).not.toBeInTheDocument();
    const group = `cron:${SIG}`;
    expect(screen.getByTestId(`dlq-group-count-${group}`)).toHaveTextContent('3');
    expect(screen.getByTestId(`dlq-group-failure-${group}`)).toHaveTextContent('Task timed out');
    expect(screen.getByTestId(`dlq-group-burst-${group}`)).toHaveTextContent('Stopped');
    expect(
      within(screen.getByTestId('dlq-groups-table'))
        .getAllByRole('row')
        .filter(row => row.dataset.rowId)
    ).toHaveLength(2);
  });

  it('opens the messages of a group filtered to its queue and failure', async () => {
    renderTab({ view: 'groups' });
    await userEvent.click(screen.getByTestId(`dlq-group-show-cron:${SIG}`));
    expect(screen.getByTestId('dlq-messages-table')).toBeTruthy();
    const search = h.navigate.mock.calls.at(-1)?.[0].search({});
    expect(search).toMatchObject({ dlqQueue: 'cron', dlqFailure: SIG });
  });

  it('opens on the messages view, filtered and labelled, for a failure-group link', () => {
    h.search = { dlqQueue: 'cron', dlqFailure: SIG };
    renderTab({ view: 'groups' });
    expect(rowIds()).toEqual(['c1', 'c2', 'c3']);
    expect(screen.getByTestId('dlq-failure-filter')).toHaveTextContent('Task timed out');
  });

  it('discards a whole group on the server with the reason its recommendation implies', async () => {
    h.groupDiscard.mockResolvedValue({ discarded: 71, failed: 0, historyPending: 0, complete: true });
    renderTab({ view: 'groups' });
    await userEvent.click(screen.getByTestId(`dlq-group-discard-cron:${SIG}`));
    expect(screen.getByTestId('dlq-group-discard-failure')).toHaveTextContent('Task timed out');
    await userEvent.click(screen.getByTestId('dlq-group-discard-dialog-confirm-btn'));
    expect(h.groupDiscard).toHaveBeenCalledWith(
      expect.objectContaining({ queueLabel: 'cron', failureSignature: SIG, reason: 'Job obsolete' })
    );
    await waitFor(() => expect(screen.queryByTestId('dlq-group-discard-dialog-confirm-btn')).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledWith(
      'Discarded 71 messages; none of this group is left. Queue counts catch up within about a minute.'
    );
  });

  it('shows progress while the group discard runs and the outcome when it stops short', async () => {
    let finish: (value: unknown) => void = () => undefined;
    h.groupDiscard.mockImplementation(({ onProgress }: { onProgress: (done: number) => void }) => {
      onProgress(50);
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    renderTab({ view: 'groups' });
    await userEvent.click(screen.getByTestId(`dlq-group-discard-cron:${SIG}`));
    await userEvent.click(screen.getByTestId('dlq-group-discard-dialog-confirm-btn'));
    expect(await screen.findByTestId('dlq-group-discard-progress')).toHaveTextContent('50 so far');
    finish({ discarded: 50, failed: 0, historyPending: 0, complete: false, stopped: 'no_progress' });
    await waitFor(() => expect(screen.queryByTestId('dlq-group-discard-progress')).not.toBeInTheDocument());
    expect(toast.warning).toHaveBeenCalledWith(
      'Discarded 50 messages; no more matching messages were found this time. Queue counts catch up within about a minute.'
    );
  });

  it('offers no group discard for a message whose failure could not be looked up', () => {
    state.messages = [message('cron', 'u1', 1, { failureSignature: 'unavailable', failureLookupFailed: true })];
    renderTab({ view: 'groups' });
    expect(screen.getByTestId('dlq-group-discard-cron:unavailable:u1')).toBeDisabled();
  });

  it('shows the selected-discard progress in the dialog', async () => {
    let finish: (value: unknown) => void = () => undefined;
    h.discard.mockImplementation(({ onProgress }: { onProgress: (done: number) => void }) => {
      onProgress(1);
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    renderTab();
    selectRow('c1');
    selectRow('c2');
    await userEvent.click(screen.getByTestId('dlq-bulk-discard'));
    // A shared discard recommendation fills in the reason, so the confirm is ready.
    await userEvent.click(screen.getByTestId('dlq-discard-dialog-confirm-btn'));
    expect(await screen.findByTestId('dlq-discard-progress')).toHaveTextContent('1 of 2 done');
    finish([
      { messageId: 'c1', queueLabel: 'cron', status: 'discarded' },
      { messageId: 'c2', queueLabel: 'cron', status: 'discarded' },
    ]);
    await waitFor(() => expect(screen.queryByTestId('dlq-discard-progress')).not.toBeInTheDocument());
  });
});

describe('DlqReplayTab counts after a discard', () => {
  it('never shows more messages than the discard left while SQS catches up', () => {
    h.ceilings = { billing: { ceiling: 0, until: Date.now() + 60_000 } };
    renderTab();
    // billing reports 2 (lagging) but the discard left 0; files and cron hold 1 each.
    expect(screen.getByTestId('dlq-stats-failed')).toHaveTextContent('2');
    expect(screen.getByTestId('dlq-stats-with-messages')).toHaveTextContent('2');
  });

  it('goes back to the SQS count once the lag window ends', () => {
    h.ceilings = { billing: { ceiling: 0, until: Date.now() - 1 } };
    renderTab();
    expect(screen.getByTestId('dlq-stats-failed')).toHaveTextContent('4');
  });
});
