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
  queues: [] as Array<Record<string, unknown>>,
}));

const QUEUE_ONE = {
  label: 'q1',
  displayName: 'Queue One',
  application: 'app',
  approximateMessageCount: 1,
  approximateNotVisibleCount: 0,
};

const h = vi.hoisted(() => ({ user: null as null | { isAdmin?: boolean; adminPermissions?: string[] } }));

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: h.user }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@client/app/hooks/data/dlqManagement', () => ({
  useDlqQueues: () => ({
    data: state.queues,
    isLoading: false,
    isError: false,
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

const selectQueue = async (name: RegExp) => {
  await userEvent.click(screen.getByRole('combobox'));
  await userEvent.click(await screen.findByRole('option', { name }));
};

const renderWithQueueSelected = async (name = /Queue One/) => {
  render(
    <CssVarsProvider theme={theme}>
      <DlqReplayTab />
    </CssVarsProvider>
  );
  await selectQueue(name);
};

beforeEach(() => {
  state.history = [];
  state.queues = [QUEUE_ONE];
  h.user = null;
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
