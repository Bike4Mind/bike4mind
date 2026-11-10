import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy/styles';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockQueues = [
  {
    label: 'quest',
    displayName: 'Quest queue',
    application: 'client',
    approximateMessageCount: 2,
    approximateNotVisibleCount: 0,
  },
];
const mockMessages = [
  {
    messageId: 'm1',
    body: '{"a":1}',
    receiptHandle: 'rh1',
    sentTimestamp: '1700000000000',
    approximateReceiveCount: '14',
  },
];

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

vi.mock('@client/app/hooks/data/dlqManagement', () => ({
  useDlqQueues: () => ({
    data: mockQueues,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useDlqMessages: () => ({
    data: mockMessages,
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

import DlqReplayTab from './DlqReplayTab';

const selectQueue = () => {
  const selector = screen.getByTestId('dlq-queue-selector');
  fireEvent.click(selector);
  const option = screen.getByTestId('dlq-queue-option-quest');
  fireEvent.click(option);
};

function renderTab() {
  const result = render(
    <CssVarsProvider>
      <DlqReplayTab />
    </CssVarsProvider>
  );
  fireEvent.click(screen.getByTestId('dlq-toggle-history'));
  return result;
}

beforeEach(() => {
  state.history = [];
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

describe('DlqReplayTab messages table', () => {
  it('renders the "Attempts" column header instead of "Receives" after selecting a queue', () => {
    render(
      <CssVarsProvider>
        <DlqReplayTab />
      </CssVarsProvider>
    );
    selectQueue();
    const table = screen.getByTestId('dlq-messages-table');
    expect(within(table).getByText('Attempts')).toBeInTheDocument();
    expect(within(table).queryByText('Receives')).toBeNull();
  });

  it('wraps "Attempts" in a Tooltip with an explanatory title', () => {
    render(
      <CssVarsProvider>
        <DlqReplayTab />
      </CssVarsProvider>
    );
    selectQueue();
    const attemptsHeader = within(screen.getByTestId('dlq-messages-table')).getByText('Attempts');
    const tooltipWrapper = attemptsHeader.closest('[aria-label], [title]') ?? attemptsHeader.parentElement;
    const titleAttr = tooltipWrapper?.getAttribute('title') ?? tooltipWrapper?.getAttribute('aria-label') ?? '';
    expect(titleAttr).toContain('failed to process');
  });
});
