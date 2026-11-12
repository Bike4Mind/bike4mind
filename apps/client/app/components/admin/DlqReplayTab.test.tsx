import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import DlqReplayTab from './DlqReplayTab';

const state = vi.hoisted(() => ({
  retentionSeconds: undefined as number | undefined,
  messages: [] as Array<{
    messageId: string;
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
    status: 'success' | 'failed' | 'skipped';
    errorMessage?: string;
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

const q = vi.hoisted(() => ({ isError: false }));

// A minimal URL store: navigate writes the search, useSearch re-renders on change.
const router = vi.hoisted(() => {
  let search: Record<string, unknown> = {};
  const listeners = new Set<() => void>();
  const set = (next: Record<string, unknown>) => {
    search = next;
    listeners.forEach(listener => listener());
  };
  return {
    get: () => search,
    set,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    navigate: vi.fn(
      (opts: { search: Record<string, unknown> | ((prev: Record<string, unknown>) => Record<string, unknown>) }) =>
        set(typeof opts.search === 'function' ? opts.search(search) : opts.search)
    ),
  };
});

vi.mock('@tanstack/react-router', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useSearch: () => useSyncExternalStore(router.subscribe, router.get),
    useNavigate: () => router.navigate,
  };
});

const h = vi.hoisted(() => ({
  replay: vi.fn(),
  user: null as null | { isAdmin?: boolean; adminPermissions?: string[] },
  queueLogsUrl: null as string | null,
  messages: [] as Array<Record<string, unknown>>,
}));

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: h.user }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@client/app/hooks/data/dlqManagement', () => ({
  useDlqQueues: () => ({
    data: state.queues.map(q => ({ messageRetentionSeconds: state.retentionSeconds, logsUrl: h.queueLogsUrl, ...q })),
    dataUpdatedAt: Date.UTC(2026, 10, 11, 9, 30),
    isLoading: false,
    isError: q.isError,
    refetch: vi.fn(),
  }),
  useDlqMessages: () => ({
    data: h.messages.length ? h.messages : state.messages,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useDlqReplay: () => ({
    mutateAsync: h.replay,
    isPending: false,
    data: null,
    reset: vi.fn(),
  }),
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
  await userEvent.click(screen.getByRole('combobox'));
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
  state.messages = [{ messageId: 'm1', body: '{}', sentTimestamp: '1700000000000', approximateReceiveCount: '1' }];
  h.replay.mockReset();
  state.history = [];
  state.queues = [QUEUE_ONE];
  state.retentionSeconds = undefined;
  h.user = null;
  h.queueLogsUrl = null;
  h.messages = [];
  q.isError = false;
  router.set({});
  router.navigate.mockClear();
});

const renderPlain = () =>
  render(
    <CssVarsProvider theme={theme}>
      <DlqReplayTab />
    </CssVarsProvider>
  );

describe('DlqReplayTab all-clear state', () => {
  it('replaces the counts with an all-clear card when every queue is empty', () => {
    state.queues = [
      { ...QUEUE_ONE, approximateMessageCount: 0 },
      { ...QUEUE_ONE, label: 'q2', approximateMessageCount: 0 },
    ];
    renderPlain();

    expect(screen.getByTestId('dlq-all-clear')).toHaveTextContent('No dead letters');
    expect(screen.getByTestId('dlq-all-clear')).toHaveTextContent(
      `Last checked ${new Date(Date.UTC(2026, 10, 11, 9, 30)).toLocaleTimeString()}`
    );
    expect(screen.queryByTestId('dlq-stats-total')).toBeNull();
  });

  it.each([
    ['a queue has messages', { approximateMessageCount: 2 }],
    ['a message is in flight', { approximateMessageCount: 0, approximateNotVisibleCount: 1 }],
    ['a queue count failed to load', { approximateMessageCount: -1, approximateNotVisibleCount: -1 }],
  ])('keeps the counts when %s', (_label, counts) => {
    state.queues = [{ ...QUEUE_ONE, ...counts }];
    renderPlain();

    expect(screen.queryByTestId('dlq-all-clear')).toBeNull();
    expect(screen.getByTestId('dlq-stats-total')).toBeInTheDocument();
  });
});

describe('DlqReplayTab all-clear after a failed refetch', () => {
  it('shows the load error, not the all-clear card, when the last good read was empty', () => {
    state.queues = [{ ...QUEUE_ONE, approximateMessageCount: 0 }];
    q.isError = true;
    renderPlain();

    expect(screen.queryByTestId('dlq-all-clear')).toBeNull();
    expect(screen.getByText('The dead-letter queues failed to load.')).toBeInTheDocument();
  });
});

describe('DlqReplayTab queue deep link', () => {
  it('opens on the queue named in the URL', () => {
    router.set({ dlqQueue: 'q1' });
    renderPlain();

    expect(screen.getByTestId('dlq-replay-all')).toBeInTheDocument();
    expect(screen.getByTestId('dlq-messages-table')).toBeInTheDocument();
    expect(screen.queryByTestId('dlq-unknown-queue')).toBeNull();
  });

  it('explains a queue the page does not list instead of selecting it', () => {
    router.set({ dlqQueue: 'alarm-only' });
    renderPlain();

    expect(screen.getByTestId('dlq-unknown-queue')).toHaveTextContent('alarm-only');
    expect(screen.queryByTestId('dlq-messages-table')).toBeNull();
  });

  it('writes a picked queue to the URL', async () => {
    await renderWithQueueSelected();

    expect(router.navigate).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
    expect(router.get()).toMatchObject({ dlqQueue: 'q1' });
  });
});

describe('DlqReplayTab failure metadata', () => {
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
});

describe('DlqReplayTab replay permission', () => {
  it('disables both replay buttons for a support:read viewer', async () => {
    h.user = { isAdmin: false, adminPermissions: ['support:read'] };
    await renderWithQueueSelected();

    expect(screen.getByTestId('dlq-replay-all')).toBeDisabled();
    expect(screen.getByTestId('dlq-replay-single-m1')).toBeDisabled();
  });

  it('enables both replay buttons for a settings:manage delegate', async () => {
    h.user = { isAdmin: false, adminPermissions: ['settings:manage'] };
    await renderWithQueueSelected();

    expect(screen.getByTestId('dlq-replay-all')).toBeEnabled();
    expect(screen.getByTestId('dlq-replay-single-m1')).toBeEnabled();
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
