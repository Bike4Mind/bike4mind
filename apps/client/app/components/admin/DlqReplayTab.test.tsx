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
    status: 'success' | 'failed' | 'skipped' | 'discarded';
    errorMessage?: string;
    reason?: string;
    replayedBy: string;
    replayedByName: string;
    createdAt: string;
  }>,
}));

const h = vi.hoisted(() => ({
  user: null as null | { isAdmin?: boolean; adminPermissions?: string[] },
  discard: vi.fn(),
}));

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: h.user }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@client/app/hooks/data/dlqManagement', () => ({
  useDlqQueues: () => ({
    data: [
      {
        label: 'q1',
        displayName: 'Queue One',
        application: 'app',
        approximateMessageCount: 1,
        approximateNotVisibleCount: 0,
      },
    ],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useDlqMessages: () => ({
    data: [
      {
        messageId: 'm1',
        receiptHandle: 'receipt-1',
        body: '{}',
        sentTimestamp: '1700000000000',
        approximateReceiveCount: '1',
      },
    ],
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
  h.discard.mockReset();
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
});
