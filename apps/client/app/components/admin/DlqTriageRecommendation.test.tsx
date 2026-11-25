import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { DlqTriageRecommendation } from './DlqTriageRecommendation';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: h }));
vi.mock('./shared/MissingPermission', () => ({
  AdminPermissionAction: ({ children }: { children: (disabled: boolean) => React.ReactNode }) => children(false),
}));
vi.mock('./shared/ActionDialog', () => ({
  ActionDialog: ({ open, onConfirm }: { open: boolean; onConfirm: (reason: string) => Promise<void> }) =>
    open ? (
      <button
        data-testid="triage-test-confirm"
        onClick={() => {
          void onConfirm('Recorded refusal').catch(() => {});
        }}
      >
        Confirm
      </button>
    ) : null,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
const theme = extendTheme({ ...getThemeConfig() });

beforeEach(() => {
  vi.clearAllMocks();
  h.get.mockResolvedValue({
    data: {
      suggestion: {
        id: 'a'.repeat(24),
        verdict: 'discard',
        actionClass: 'terminal-refusal',
        status: 'pending',
        reasons: [{ text: 'Recorded refusal' }],
      },
    },
  });
});

describe('DLQ triage decisions', () => {
  const setup = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CssVarsProvider theme={theme}>
          <DlqTriageRecommendation queueLabel="quest" messageId="m1" />
        </CssVarsProvider>
      </QueryClientProvider>
    );
  };
  it('approves discard through the audited endpoint with suggestion linkage', async () => {
    h.post.mockResolvedValue({ data: { discarded: 1, results: [] } });
    setup();
    fireEvent.click(await screen.findByTestId('dlq-triage-approve-m1'));
    fireEvent.click(screen.getByTestId('triage-test-confirm'));
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/api/admin/dlq/discard', {
        queueLabel: 'quest',
        messageIds: ['m1'],
        aiSuggestionId: 'a'.repeat(24),
        reason: 'Recorded refusal',
      })
    );
  });
  it('refreshes the claimed decision after a failed approval', async () => {
    h.post.mockRejectedValue(new Error('Action failed'));
    setup();
    fireEvent.click(await screen.findByTestId('dlq-triage-approve-m1'));
    fireEvent.click(screen.getByTestId('triage-test-confirm'));
    await waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('triage-test-confirm')).not.toBeInTheDocument();
  });
  it('dismisses with the current suggestion identity', async () => {
    h.post.mockResolvedValue({ data: {} });
    setup();
    fireEvent.click(await screen.findByTestId('dlq-triage-dismiss-m1'));
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/api/admin/dlq/triage', {
        queue: 'quest',
        message: 'm1',
        suggestionId: 'a'.repeat(24),
        decision: 'dismiss',
      })
    );
  });
  it('never presents authorization as a completed queue action', async () => {
    h.get.mockResolvedValue({
      data: {
        suggestion: {
          id: 'a'.repeat(24),
          verdict: 'replay',
          actionClass: 'safe-transient',
          status: 'accepted',
          reasons: [],
        },
      },
    });
    setup();
    expect(await screen.findByTestId('dlq-triage-execution-m1')).toHaveTextContent('Execution outcome unconfirmed');
    expect(screen.getByTestId('dlq-triage-m1')).toHaveTextContent('Authorized');
    expect(screen.queryByTestId('dlq-triage-approve-m1')).not.toBeInTheDocument();
  });
  it('shows partial evidence, the registered owner and a sanitized draft without offering replay for a bug', async () => {
    h.get.mockResolvedValue({
      data: {
        suggestion: {
          id: 'a'.repeat(24),
          verdict: 'investigate',
          actionClass: 'review-required',
          status: 'pending',
          reasons: [],
          proposedAction: {
            facts: {
              coverage: 'partial-sqs-sample',
              failureSource: 'recorded',
              failureCategory: 'bug',
              consumerVersion: 'unknown',
              fixVerification: 'unavailable',
              entityContext: 'present-id-withheld',
              owner: 'Accounts',
              expiry: { status: 'within-24-hours', estimatedExpiresAt: null, explanation: 'Estimate only.' },
              logFallback: { status: 'not-needed', sampledEvents: 0 },
              issueDraft: { title: 'Investigate consumer failure', body: 'Fix relationship unavailable.' },
            },
          },
        },
      },
    });
    setup();
    const evidence = await screen.findByTestId('dlq-triage-evidence-m1');
    expect(evidence).toHaveTextContent('Partial SQS sample; not an inventory');
    expect(evidence).toHaveTextContent('Failure: Recorded');
    expect(evidence).toHaveTextContent('Entity context: Present (ID withheld)');
    expect(evidence).toHaveTextContent('Consumer logs: Not needed');
    expect(evidence).toHaveTextContent('Expiry: Within 24 hours');
    expect(evidence).not.toHaveTextContent('present-id-withheld');
    expect(evidence).toHaveTextContent('Registered owner: Accounts');
    expect(evidence).toHaveTextContent('no fix has been verified');
    expect(screen.getByTestId('dlq-triage-draft-m1')).toHaveTextContent('Fix relationship unavailable');
    expect(screen.queryByTestId('dlq-triage-approve-m1')).not.toBeInTheDocument();
  });
  it.each([
    ['success', 'Replay send acknowledged. Consumer outcome unknown.'],
    ['discarded', 'Discard deletion acknowledged.'],
    ['pending', 'Operation started; execution outcome unconfirmed.'],
    ['failed', 'Operation request failed'],
    ['skipped', 'Operation skipped; no replay was sent.'],
  ])('shows durable %s separately from authorization', async (status, text) => {
    h.get.mockResolvedValue({
      data: {
        suggestion: { id: 'a'.repeat(24), verdict: 'replay', status: 'accepted', reasons: [] },
        execution: { status, operation: 'replay', hasWarning: true, recordedAt: '2026-11-17T00:00:00Z' },
      },
    });
    setup();
    const execution = await screen.findByTestId('dlq-triage-execution-m1');
    expect(execution).toHaveTextContent(text);
    expect(execution).toHaveTextContent('Operation warning recorded');
    expect(screen.getByText(/^Recorded .* ago$|^Recorded (now|yesterday)$/)).toHaveAttribute(
      'datetime',
      '2026-11-17T00:00:00.000Z'
    );
    expect(screen.getByTestId('dlq-triage-m1')).toHaveTextContent('Authorized');
  });
});
