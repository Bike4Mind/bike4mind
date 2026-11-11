import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import DlqReplayTab from './DlqReplayTab';

const state = vi.hoisted(() => ({
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
}));

type QueueRow = {
  label: string;
  displayName: string;
  application: string;
  approximateMessageCount: number;
  approximateNotVisibleCount: number;
};
const queueOne = (counts: Partial<QueueRow> = {}): QueueRow => ({
  label: 'q1',
  displayName: 'Queue One',
  application: 'app',
  approximateMessageCount: 1,
  approximateNotVisibleCount: 0,
  ...counts,
});
const q = vi.hoisted(() => ({ queues: [] as QueueRow[], isError: false }));

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

const h = vi.hoisted(() => ({ user: null as null | { isAdmin?: boolean; adminPermissions?: string[] } }));

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: h.user }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@client/app/hooks/data/dlqManagement', () => ({
  useDlqQueues: () => ({
    data: q.queues,
    dataUpdatedAt: Date.UTC(2026, 10, 11, 9, 30),
    isLoading: false,
    isError: q.isError,
    refetch: vi.fn(),
  }),
  useDlqMessages: () => ({
    data: [{ messageId: 'm1', body: '{}', sentTimestamp: '1700000000000', approximateReceiveCount: '1' }],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useDlqReplay: () => ({
    mutateAsync: vi.fn(),
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

const renderWithQueueSelected = async () => {
  render(
    <CssVarsProvider theme={theme}>
      <DlqReplayTab />
    </CssVarsProvider>
  );
  await userEvent.click(screen.getByRole('combobox'));
  await userEvent.click(await screen.findByRole('option', { name: /Queue One/ }));
};

beforeEach(() => {
  state.history = [];
  h.user = null;
  q.queues = [queueOne()];
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
    q.queues = [queueOne({ approximateMessageCount: 0 }), { ...queueOne({ approximateMessageCount: 0 }), label: 'q2' }];
    renderPlain();

    expect(screen.getByTestId('dlq-all-clear')).toHaveTextContent('No dead letters');
    expect(screen.getByTestId('dlq-all-clear-checked')).toHaveTextContent(
      `Last checked ${new Date(Date.UTC(2026, 10, 11, 9, 30)).toLocaleTimeString()}`
    );
    expect(screen.queryByTestId('dlq-stats-total')).toBeNull();
  });

  it.each([
    ['a queue has messages', { approximateMessageCount: 2 }],
    ['a message is in flight', { approximateMessageCount: 0, approximateNotVisibleCount: 1 }],
    ['a queue count failed to load', { approximateMessageCount: -1, approximateNotVisibleCount: -1 }],
  ])('keeps the counts when %s', (_label, counts) => {
    q.queues = [queueOne(counts)];
    renderPlain();

    expect(screen.queryByTestId('dlq-all-clear')).toBeNull();
    expect(screen.getByTestId('dlq-stats-total')).toBeInTheDocument();
  });
});

describe('DlqReplayTab all-clear after a failed refetch', () => {
  it('shows the load error, not the all-clear card, when the last good read was empty', () => {
    q.queues = [queueOne({ approximateMessageCount: 0 })];
    q.isError = true;
    renderPlain();

    expect(screen.queryByTestId('dlq-all-clear')).toBeNull();
    expect(screen.getByText('Failed to load DLQ list. Try refreshing.')).toBeInTheDocument();
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
