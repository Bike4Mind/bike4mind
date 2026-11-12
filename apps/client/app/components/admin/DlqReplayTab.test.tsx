import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import DlqReplayTab from './DlqReplayTab';

const state = vi.hoisted(() => ({
  compact: false,
  messagesLoading: false,
  messagesError: false,
  retentionSeconds: undefined as number | undefined,
  messages: [] as Array<{
    messageId: string;
    receiptHandle?: string;
    body: string;
    sentTimestamp: string;
    approximateReceiveCount: string;
    failureLookupFailed?: boolean;
    failure?: { errorMessage: string; category: 'timeout' };
  }>,
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
}));

const QUEUE_ONE = {
  label: 'q1',
  displayName: 'Queue One',
  application: 'app',
  approximateMessageCount: 1,
  approximateNotVisibleCount: 0,
};

const h = vi.hoisted(() => ({
  discard: vi.fn(),
  replay: vi.fn(),
  user: null as null | { isAdmin?: boolean; adminPermissions?: string[] },
  queueLogsUrl: null as string | null,
  messages: [] as Array<Record<string, unknown>>,
}));

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: h.user }) }));
vi.mock('@mui/system/useMediaQuery', () => ({ default: () => state.compact }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@client/app/hooks/data/dlqManagement', () => ({
  useDlqQueues: () => ({
    data: state.queues.map(q => ({ messageRetentionSeconds: state.retentionSeconds, logsUrl: h.queueLogsUrl, ...q })),
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useDlqMessages: () => ({
    data: h.messages.length ? h.messages : state.messages,
    isLoading: state.messagesLoading,
    isError: state.messagesError,
    refetch: vi.fn(),
  }),
  useDlqReplay: () => ({
    mutateAsync: h.replay,
    isPending: false,
    data: null,
    reset: vi.fn(),
  }),
  useDlqDiscard: () => ({ mutateAsync: h.discard, isPending: false }),
  useDlqHistory: () => ({
    data: state.history,
    isLoading: false,
    isError: false,
  }),
}));

const theme = extendTheme({ ...getThemeConfig() });

function renderTab() {
  const result = render(
    <CssVarsProvider theme={theme}>
      <DlqReplayTab />
    </CssVarsProvider>
  );
  fireEvent.click(screen.getByTestId('dlq-toggle-history'));
  return result;
}

const selectQueue = async (name: RegExp) => {
  await userEvent.click(within(screen.getByTestId('dlq-queue-selector')).getByRole('combobox'));
  await userEvent.click(await screen.findByRole('option', { name }));
};

const renderWithQueueSelected = async (name = /Queue One/) => {
  const view = render(
    <CssVarsProvider theme={theme}>
      <DlqReplayTab />
    </CssVarsProvider>
  );
  await selectQueue(name);
  return view;
};

beforeEach(() => {
  vi.clearAllMocks();
  state.compact = false;
  state.messagesLoading = false;
  state.messagesError = false;
  state.messages = [
    {
      messageId: 'm1',
      receiptHandle: 'receipt-1',
      body: '{}',
      sentTimestamp: '1700000000000',
      approximateReceiveCount: '1',
    },
  ];
  state.history = [];
  state.queues = [QUEUE_ONE];
  state.retentionSeconds = undefined;
  h.user = null;
  h.discard.mockReset();
  h.replay.mockReset();
  h.queueLogsUrl = null;
  h.messages = [];
});

describe('DlqReplayTab toolkit presentation', () => {
  it('puts the message and failure on a single compact column with visible actions', async () => {
    state.compact = true;
    state.messages[0].failure = { errorMessage: 'worker timed out', category: 'timeout' };
    await renderWithQueueSelected();
    const table = screen.getByTestId('dlq-messages-table');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(1);
    const row = screen.getByTestId('dlq-message-row-m1');
    expect(within(row).getAllByRole('cell')).toHaveLength(1);
    expect(row).toHaveTextContent('m1');
    expect(row).toHaveTextContent('worker timed out');
    expect(within(row).getByTestId('dlq-recommendation-m1')).toHaveTextContent('Recorded transient failure: timeout.');
    await userEvent.click(screen.getByTestId('dlq-view-m1'));
    expect(screen.getByTestId('dlq-failure-reason')).toHaveTextContent('worker timed out');
  });

  it('shows an empty state rather than a blank table', async () => {
    state.messages = [];
    await renderWithQueueSelected();
    expect(screen.getByText('No messages in this queue')).toBeInTheDocument();
  });

  it('replaces stale rows with the shared error state', async () => {
    state.messagesError = true;
    await renderWithQueueSelected();
    expect(screen.getByText('Messages failed to load.')).toBeInTheDocument();
    expect(screen.queryByTestId('dlq-message-row-m1')).not.toBeInTheDocument();
  });

  it.each([
    ['dlq-replay-all', 'dlq-replay-dialog', 'dlq-replay-confirm'],
    ['dlq-replay-single-m1', 'dlq-single-replay-dialog', 'dlq-single-replay-confirm'],
  ])('uses a reason picker in the %s confirmation', async (openId, dialogId, confirmId) => {
    h.user = { isAdmin: true };
    await renderWithQueueSelected();
    await userEvent.click(screen.getByTestId(openId));
    expect(screen.getByTestId(confirmId)).toBeDisabled();
    expect(screen.getByTestId(`${dialogId}-reason-input-helper`)).toHaveTextContent('Recorded in the audit log');
    fireEvent.change(screen.getByTestId(`${dialogId}-reason-input`), { target: { value: 'Reviewed the failure' } });
    expect(screen.getByTestId(confirmId)).toBeEnabled();
    await userEvent.click(screen.getByTestId(`${dialogId}-cancel-btn`));
    expect(h.replay).not.toHaveBeenCalled();
  });
});

describe('DlqReplayTab failure metadata', () => {
  it('shows an advisory recommendation and its basis on each row', async () => {
    state.messages[0].failure = { errorMessage: 'worker timed out', category: 'timeout' };
    await renderWithQueueSelected();
    expect(screen.getByTestId('dlq-recommendation-m1')).toHaveTextContent('Replay');
    expect(screen.getByTestId('dlq-recommendation-m1')).toHaveTextContent('Recorded transient failure: timeout.');
    expect(screen.getByTestId('dlq-recommendation-m1')).toHaveTextContent('Advisory only');
  });

  it('shows recorded reason and category in the row and drawer', async () => {
    state.messages[0].failure = { errorMessage: 'worker timed out', category: 'timeout' };
    await renderWithQueueSelected();
    expect(screen.getByTestId('dlq-reason-m1')).toHaveTextContent('worker timed out');
    expect(screen.getByTestId('dlq-category-m1')).toHaveTextContent('timeout');
    expect(screen.queryByTestId('dlq-failure-lookup-warning')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('dlq-view-m1'));
    expect(screen.getByTestId('dlq-failure-reason')).toHaveTextContent('worker timed out');
    expect(screen.getByTestId('dlq-failure-category')).toHaveTextContent('timeout');
  });

  it('keeps messages and their drawer available when failure details cannot be loaded', async () => {
    state.messages[0].failureLookupFailed = true;
    await renderWithQueueSelected();
    expect(screen.getByTestId('dlq-failure-lookup-warning')).toHaveTextContent(
      'Failure details are temporarily unavailable. Queue messages are still shown.'
    );
    expect(screen.getByTestId('dlq-reason-m1')).toHaveTextContent('Unknown');
    expect(screen.getByTestId('dlq-category-m1')).toHaveTextContent('Unknown');
    await userEvent.click(screen.getByTestId('dlq-view-m1'));
    expect(screen.getByTestId('dlq-failure-reason')).toHaveTextContent('Unknown');
  });

  it('shows Unknown for an uninstrumented or historical message', async () => {
    await renderWithQueueSelected();
    expect(screen.getByTestId('dlq-reason-m1')).toHaveTextContent('Unknown');
    expect(screen.getByTestId('dlq-category-m1')).toHaveTextContent('Unknown');
    expect(screen.queryByTestId('dlq-failure-lookup-warning')).not.toBeInTheDocument();
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

    const table = screen.getByTestId('dlq-history-table');
    const headers = within(table).getAllByRole('columnheader');
    const headerTexts = headers.map(h => h.textContent);

    expect(headerTexts).toContain('Feature');
    expect(headerTexts).toContain('By');
    expect(headerTexts).not.toContain('Queue');

    expect(screen.getByText('FabFile Vectorize')).toBeTruthy();
    expect(screen.getByText('Image Generation')).toBeTruthy();

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
    expect(
      within(screen.getByTestId('dlq-history-row-pending-1')).getByText('Discard outcome unconfirmed')
    ).toBeTruthy();
    const failed = within(screen.getByTestId('dlq-history-row-failed-1'));
    expect(failed.getByText('Discard request failed')).toBeTruthy();
    expect(failed.getByText(/expired receipt/)).toHaveTextContent('Job obsolete');
    expect(within(screen.getByTestId('dlq-history-row-legacy-1')).getByText('Failed')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Recorded at' })).toBeTruthy();
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
    expect(within(screen.getByTestId('dlq-history-row-discard-1')).getByText('discarded')).toBeTruthy();
    expect(screen.getByText('Job obsolete')).toBeTruthy();
  });
});

describe('DlqReplayTab replay permission', () => {
  it.each(['side-effects', 'unsafe', undefined])(
    'shows consequences and requires a reason for %s in single and batch replay',
    async replay => {
      h.user = { isAdmin: true };
      state.queues = [
        { ...QUEUE_ONE, replay, description: 'Delivers notifications.', replayNote: 'A replay can deliver again.' },
      ];
      h.replay.mockResolvedValue({ replayed: 1, failed: 0, skipped: 0, notFound: 0, results: [] });
      await renderWithQueueSelected();
      for (const [opener, confirm, dialog] of [
        ['dlq-replay-single-m1', 'dlq-single-replay-confirm', 'dlq-single-replay-dialog'],
        ['dlq-replay-all', 'dlq-replay-confirm', 'dlq-replay-dialog'],
      ]) {
        await userEvent.click(screen.getByTestId(opener));
        expect(screen.getByTestId('dlq-replay-summary')).toHaveTextContent('Queue One');
        expect(screen.getByTestId('dlq-replay-summary')).toHaveTextContent('A replay can deliver again.');
        expect(screen.getByTestId(confirm)).toBeDisabled();
        fireEvent.change(screen.getByTestId(`${dialog}-reason-input`), { target: { value: 'Reviewed side effects' } });
        await userEvent.click(screen.getByTestId(confirm));
        expect(h.replay).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'Reviewed side effects' }));
      }
    }
  );

  it('allows a safe replay without a reason', async () => {
    h.user = { isAdmin: true };
    state.queues = [{ ...QUEUE_ONE, replay: 'safe' }];
    await renderWithQueueSelected();
    await userEvent.click(screen.getByTestId('dlq-replay-all'));
    expect(screen.getByTestId('dlq-replay-confirm')).toBeEnabled();
  });

  it('disables both replay buttons for a support:read viewer', async () => {
    h.user = { isAdmin: false, adminPermissions: ['support:read'] };
    await renderWithQueueSelected();

    expect(screen.getByTestId('dlq-replay-all')).toBeDisabled();
    expect(screen.getByTestId('dlq-replay-single-m1')).toBeDisabled();
    expect(screen.getByTestId('dlq-discard-single-m1')).toBeDisabled();
  });

  it('enables both replay buttons for a settings:manage delegate', async () => {
    h.user = { isAdmin: false, adminPermissions: ['settings:manage'] };
    await renderWithQueueSelected();

    expect(screen.getByTestId('dlq-replay-all')).toBeEnabled();
    expect(screen.getByTestId('dlq-replay-single-m1')).toBeEnabled();
    expect(screen.getByTestId('dlq-discard-single-m1')).toBeEnabled();
  });

  it('closes after an acknowledged deletion but warns when history is unconfirmed', async () => {
    h.user = { isAdmin: false, adminPermissions: ['settings:manage'] };
    h.discard.mockResolvedValue({
      discarded: 1,
      failed: 0,
      results: [{ messageId: 'm1', status: 'discarded', historyPending: true }],
    });
    await renderWithQueueSelected();
    await userEvent.click(screen.getByTestId('dlq-discard-single-m1'));
    await userEvent.click(screen.getByTestId('dlq-discard-dialog-reason-input-preset-1'));
    await userEvent.click(screen.getByTestId('dlq-discard-dialog-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('dlq-discard-dialog-confirm-btn')).not.toBeInTheDocument());
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('History outcome is unconfirmed'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('keeps the dialog open after a failed deletion request', async () => {
    h.user = { isAdmin: false, adminPermissions: ['settings:manage'] };
    h.discard.mockResolvedValue({
      discarded: 0,
      failed: 1,
      results: [{ messageId: 'm1', status: 'failed', reason: 'expired receipt', historyPending: true }],
    });
    await renderWithQueueSelected();
    await userEvent.click(screen.getByTestId('dlq-discard-single-m1'));
    await userEvent.click(screen.getByTestId('dlq-discard-dialog-reason-input-preset-1'));
    await userEvent.click(screen.getByTestId('dlq-discard-dialog-confirm-btn'));
    expect(screen.getByTestId('dlq-discard-dialog-confirm-btn')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('History outcome is unconfirmed'));
  });

  it('requires a reason and submits the selected message for discard', async () => {
    h.user = { isAdmin: false, adminPermissions: ['settings:manage'] };
    h.discard.mockResolvedValue({ discarded: 1, failed: 0, results: [{ messageId: 'm1', status: 'discarded' }] });
    await renderWithQueueSelected();
    await userEvent.click(screen.getByTestId('dlq-discard-single-m1'));
    expect(screen.getByText(/cannot be undone from this page/i)).toBeTruthy();
    const confirm = screen.getByTestId('dlq-discard-dialog-confirm-btn');
    expect(confirm).toBeDisabled();
    await userEvent.click(screen.getByTestId('dlq-discard-dialog-reason-input-preset-1'));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(h.discard).toHaveBeenCalledWith({
      queueLabel: 'q1',
      reason: 'Job obsolete',
      messages: [{ messageId: 'm1', receiptHandle: 'receipt-1', body: '{}' }],
    });
  });

  it.each([
    [
      'a failed result',
      () =>
        h.discard.mockResolvedValue({
          discarded: 0,
          failed: 1,
          results: [{ messageId: 'm1', status: 'failed', reason: 'expired receipt' }],
        }),
      'Discard failed: expired receipt',
    ],
    ['a rejected request', () => h.discard.mockRejectedValue(new Error('boom')), 'Discard failed: boom'],
  ])('reports %s and keeps the dialog open', async (_name, arrange, message) => {
    h.user = { isAdmin: false, adminPermissions: ['settings:manage'] };
    arrange();
    await renderWithQueueSelected();
    await userEvent.click(screen.getByTestId('dlq-discard-single-m1'));
    await userEvent.click(screen.getByTestId('dlq-discard-dialog-reason-input-preset-1'));
    await userEvent.click(screen.getByTestId('dlq-discard-dialog-confirm-btn'));
    expect(toast.error).toHaveBeenCalledWith(message);
    expect(screen.getByTestId('dlq-discard-dialog-confirm-btn')).toBeTruthy();
  });
});

describe('DlqReplayTab messages table', () => {
  it('labels the SQS receive count accurately after selecting a queue', async () => {
    await renderWithQueueSelected();
    const table = screen.getByTestId('dlq-messages-table');
    expect(within(table).getByText('Receives')).toBeInTheDocument();
    expect(within(table).queryByText('Attempts')).toBeNull();
  });

  it('explains that browser views contribute to the receive count', async () => {
    await renderWithQueueSelected();
    const receives = within(screen.getByTestId('dlq-message-row-m1')).getByText('1');
    await userEvent.hover(receives);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('including views in this browser');
    expect(tooltip).toHaveTextContent('not a count of handler failures');
  });
});

describe('DlqReplayTab consumer log links', () => {
  const queueUrl = 'https://us-east-2.console.aws.amazon.com/cloudwatch/home?region=us-east-2#queue';
  const rowUrl = 'https://us-east-2.console.aws.amazon.com/cloudwatch/home?region=us-east-2#m1';

  const expectNewTabLink = (el: HTMLElement, href: string) => {
    expect(el).toHaveAttribute('href', href);
    expect(el).toHaveAttribute('target', '_blank');
    expect(el).toHaveAttribute('rel', 'noopener noreferrer');
  };

  it('links the queue, each row and the drawer to their own logs window', async () => {
    h.queueLogsUrl = queueUrl;
    h.messages = [
      { messageId: 'm1', body: '{}', sentTimestamp: String(1_700_000_000_000), logsUrl: rowUrl },
      { messageId: 'm2', body: '{}', sentTimestamp: String(1_700_000_000_000), logsUrl: null },
    ];
    await renderWithQueueSelected();

    expectNewTabLink(screen.getByTestId('dlq-queue-logs'), queueUrl);
    expectNewTabLink(screen.getByTestId('dlq-logs-m1'), rowUrl);
    expect(screen.queryByTestId('dlq-logs-m2')).toBeNull();

    fireEvent.click(screen.getByTestId('dlq-view-m1'));
    expectNewTabLink(await screen.findByTestId('dlq-drawer-logs'), rowUrl);
  });

  it('hides every log link when the API returns none', async () => {
    await renderWithQueueSelected();

    expect(screen.queryByTestId('dlq-queue-logs')).toBeNull();
    expect(screen.queryByTestId('dlq-logs-m1')).toBeNull();
    fireEvent.click(screen.getByTestId('dlq-view-m1'));
    expect(screen.queryByTestId('dlq-drawer-logs')).toBeNull();
  });

  it('does not open the message drawer when the row log link is clicked', async () => {
    h.messages = [{ messageId: 'm1', body: '{}', sentTimestamp: String(1_700_000_000_000), logsUrl: rowUrl }];
    await renderWithQueueSelected();

    fireEvent.click(screen.getByTestId('dlq-logs-m1'));

    expect(screen.queryByTestId('dlq-drawer-close')).toBeNull();
  });
});

describe('DlqReplayTab replay destination', () => {
  it('keeps inspection and message details available when no replay destination exists', async () => {
    h.user = { isAdmin: false, adminPermissions: ['settings:manage'] };
    state.queues = [{ ...QUEUE_ONE, hasReplayDestination: false }];
    await renderWithQueueSelected();
    expect(screen.getByTestId('dlq-replay-all')).toBeDisabled();
    expect(screen.getByTestId('dlq-replay-single-m1')).toBeDisabled();
    expect(screen.getByTestId('dlq-replay-unavailable')).toHaveTextContent(
      'No replay destination is available for this queue. You can still inspect its messages.'
    );
    await userEvent.click(screen.getByTestId('dlq-view-m1'));
    expect(screen.getByTestId('dlq-drawer-expiry')).toBeInTheDocument();
    expect(h.replay).not.toHaveBeenCalled();
  });

  it.each([
    ['dlq-replay-all', 'dlq-replay-confirm'],
    ['dlq-replay-single-m1', 'dlq-single-replay-confirm'],
  ])('disables an open confirmation when the destination becomes unavailable: %s', async (openId, confirmId) => {
    h.user = { isAdmin: false, adminPermissions: ['settings:manage'] };
    state.queues = [{ ...QUEUE_ONE, hasReplayDestination: true }];
    const view = await renderWithQueueSelected();
    await userEvent.click(screen.getByTestId(openId));
    state.queues = [{ ...QUEUE_ONE, hasReplayDestination: false }];
    view.rerender(
      <CssVarsProvider theme={theme}>
        <DlqReplayTab />
      </CssVarsProvider>
    );
    expect(screen.getByTestId(confirmId)).toBeDisabled();
    fireEvent.click(screen.getByTestId(confirmId));
    expect(h.replay).not.toHaveBeenCalled();
  });

  it('keeps manual replay enabled alongside an unsafe advisory hint', async () => {
    h.user = { isAdmin: false, adminPermissions: ['settings:manage'] };
    state.queues = [
      {
        ...QUEUE_ONE,
        hasReplayDestination: true,
        description: 'Delivers notifications.',
        replay: 'unsafe',
        replayNote: 'A replay can deliver again.',
        owner: 'Notifications',
      },
    ];
    await renderWithQueueSelected();
    expect(screen.getByTestId('dlq-queue-hint-replay')).toHaveTextContent('Unsafe to replay');
    expect(screen.getByTestId('dlq-replay-all')).toBeEnabled();
    expect(screen.getByTestId('dlq-replay-single-m1')).toBeEnabled();
    expect(screen.queryByTestId('dlq-replay-unavailable')).not.toBeInTheDocument();
  });
});

describe('DlqReplayTab queue hint', () => {
  const webhooks = {
    ...QUEUE_ONE,
    label: 'webhook-delivery',
    displayName: 'Webhook Delivery',
    description: 'Delivers outbound webhooks.',
    replay: 'unsafe',
    replayNote: 'A replay posts the webhook again.',
    owner: 'Integrations',
  };
  const vectorize = {
    ...QUEUE_ONE,
    label: 'fab-file-vectorize',
    displayName: 'File Vectorize',
    description: 'Builds search vectors for a file.',
    replay: 'safe',
    replayNote: 'Vectors are upserted.',
    owner: 'Knowledge files',
  };

  it('shows the selected queue description, replay class, note and owner', async () => {
    state.queues = [webhooks, vectorize];
    await renderWithQueueSelected(/Webhook Delivery/);

    const hint = screen.getByTestId('dlq-queue-hint');
    expect(hint).toHaveTextContent('Delivers outbound webhooks.');
    expect(hint).toHaveTextContent('A replay posts the webhook again.');
    expect(hint).toHaveTextContent('Owner: Integrations');
    expect(screen.getByTestId('dlq-queue-hint-replay')).toHaveTextContent('Unsafe to replay');
    expect(screen.getByTestId('dlq-queue-hint-replay')).toHaveAttribute('data-tone', 'bad');
  });

  it('updates the hint when another queue is selected', async () => {
    state.queues = [webhooks, vectorize];
    await renderWithQueueSelected(/Webhook Delivery/);
    await selectQueue(/File Vectorize/);

    expect(screen.getByTestId('dlq-queue-hint')).toHaveTextContent('Builds search vectors for a file.');
    expect(screen.getByTestId('dlq-queue-hint-replay')).toHaveTextContent('Safe to replay');
    expect(screen.getByTestId('dlq-queue-hint-replay')).toHaveAttribute('data-tone', 'good');
  });

  it('shows an unsafe chip for a replay class this client does not know', async () => {
    state.queues = [{ ...webhooks, replay: 'needs-review' }];
    await renderWithQueueSelected(/Webhook Delivery/);

    expect(screen.getByTestId('dlq-queue-hint-replay')).toHaveTextContent('Replay safety unknown');
    expect(screen.getByTestId('dlq-queue-hint-replay')).toHaveAttribute('data-tone', 'bad');
  });

  it('shows no hint when no queue is selected', () => {
    state.queues = [webhooks];
    render(
      <CssVarsProvider theme={theme}>
        <DlqReplayTab />
      </CssVarsProvider>
    );

    expect(screen.queryByTestId('dlq-queue-hint')).not.toBeInTheDocument();
  });

  it('shows no hint for a queue without a description', async () => {
    await renderWithQueueSelected();

    expect(screen.getByTestId('dlq-replay-all')).toBeInTheDocument();
    expect(screen.queryByTestId('dlq-queue-hint')).not.toBeInTheDocument();
  });
});

describe('DlqReplayTab age and expiry', () => {
  const HOUR = 3600 * 1000;

  it('shows age and time until expiry per message', async () => {
    state.retentionSeconds = 14 * 24 * 3600;
    state.messages[0].sentTimestamp = String(Date.now() - 10.5 * HOUR);

    await renderWithQueueSelected();

    expect(screen.getByTestId('dlq-age-m1')).toHaveTextContent('10h 30m');
    expect(screen.getByTestId('dlq-expires-m1')).toHaveTextContent('13d 13h');
  });

  it('keeps age, expiry and receive values under their matching headers', async () => {
    state.retentionSeconds = 4 * 24 * 3600;
    state.messages[0].sentTimestamp = String(Date.now() - 10.5 * HOUR);

    await renderWithQueueSelected();

    const table = screen.getByTestId('dlq-messages-table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map(header => header.textContent);
    const cells = within(screen.getByTestId('dlq-message-row-m1')).getAllByRole('cell');
    expect(cells[headers.indexOf('Age')]).toHaveTextContent('10h 30m');
    expect(cells[headers.indexOf('Expires in')]).toHaveTextContent('3d 13h');
    expect(cells[headers.indexOf('Receives')]).toHaveTextContent(/^1$/);
  });

  it('shows a different expiry for a shorter retention', async () => {
    state.retentionSeconds = 4 * 24 * 3600;
    state.messages[0].sentTimestamp = String(Date.now() - 10.5 * HOUR);

    await renderWithQueueSelected();

    expect(screen.getByTestId('dlq-expires-m1')).toHaveTextContent('3d 13h');
  });

  it('flags a message within 24 hours of expiry', async () => {
    state.retentionSeconds = 4 * 24 * 3600;
    state.messages[0].sentTimestamp = String(Date.now() - 80.5 * HOUR);

    await renderWithQueueSelected();

    const expires = screen.getByTestId('dlq-expires-m1');
    expect(expires).toHaveTextContent(/^15h \d+m$/);
    expect(expires).toHaveAttribute('data-warn', 'true');
  });

  it('does not flag a message with plenty of time left', async () => {
    state.retentionSeconds = 14 * 24 * 3600;
    state.messages[0].sentTimestamp = String(Date.now() - HOUR);

    await renderWithQueueSelected();

    expect(screen.getByTestId('dlq-expires-m1')).toHaveAttribute('data-warn', 'false');
  });

  it('shows N/A for expiry when retention is unknown', async () => {
    state.messages[0].sentTimestamp = String(Date.now() - HOUR);

    await renderWithQueueSelected();

    expect(screen.getByTestId('dlq-expires-m1')).toHaveTextContent('N/A');
  });

  it('shows age and expiry in the message drawer', async () => {
    state.retentionSeconds = 4 * 24 * 3600;
    state.messages[0].sentTimestamp = String(Date.now() - 10.5 * HOUR);

    await renderWithQueueSelected();
    await userEvent.click(screen.getByTestId('dlq-view-m1'));

    expect(await screen.findByTestId('dlq-drawer-expiry')).toHaveTextContent('10h 30m old, expires in 3d 13h');
  });

  it('omits the expiry from the message drawer when retention is unknown', async () => {
    state.messages[0].sentTimestamp = String(Date.now() - HOUR);

    await renderWithQueueSelected();
    await userEvent.click(screen.getByTestId('dlq-view-m1'));

    const drawerExpiry = await screen.findByTestId('dlq-drawer-expiry');
    expect(drawerExpiry).toHaveTextContent('1h 0m old');
    expect(drawerExpiry).not.toHaveTextContent('expires');
  });
});
