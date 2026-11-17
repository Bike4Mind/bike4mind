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
});
