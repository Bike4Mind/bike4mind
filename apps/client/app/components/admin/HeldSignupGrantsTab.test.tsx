import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import HeldSignupGrantsTab from './HeldSignupGrantsTab';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: getMock, post: postMock } }));

const theme = extendTheme({ ...getThemeConfig() });
const rows = ['a', 'b'].map(letter => ({
  id: letter.repeat(24),
  email: `${letter}@example.test`,
  reason: 'budget_exhausted',
  createdAt: '2026-01-01T00:00:00.000Z',
}));

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>
        <HeldSignupGrantsTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  getMock.mockReset().mockResolvedValue({ data: { data: rows, nextCursor: null } });
  postMock.mockReset();
});

describe('HeldSignupGrantsTab', () => {
  it('keeps release disabled until a row is selected', async () => {
    renderTab();
    await screen.findByTestId(`held-signup-grants-select-${rows[0].id}`);
    expect(screen.getByTestId('held-signup-grants-release-btn')).toBeDisabled();
  });

  it('releases the selected grants, then revokes that batch', async () => {
    postMock
      .mockResolvedValueOnce({
        data: { batchId: 'batch-1', results: [{ userId: rows[1].id, outcome: 'released', credits: 12 }] },
      })
      .mockResolvedValueOnce({
        data: { batchId: 'batch-1', results: [{ userId: rows[1].id, outcome: 'reversed', credits: 12 }] },
      });
    renderTab();
    fireEvent.click(await screen.findByTestId(`held-signup-grants-select-${rows[1].id}`));
    fireEvent.click(screen.getByTestId('held-signup-grants-release-btn'));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/admin/held-signup-grants/release', { userIds: [rows[1].id] })
    );
    fireEvent.click(await screen.findByTestId('held-signup-grants-revoke-btn'));
    expect(await screen.findByTestId('held-signup-grants-revoke-dialog')).toHaveTextContent(
      'permanently debits the credits granted by this release'
    );
    expect(postMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('held-signup-grants-revoke-confirm-btn'));
    await waitFor(() =>
      expect(postMock).toHaveBeenLastCalledWith('/api/admin/held-signup-grants/revoke', { batchId: 'batch-1' })
    );
    expect(await screen.findByTestId('held-signup-grants-revoke-result')).toHaveTextContent('Revoked 1 of 1');
    expect(screen.getByTestId('held-signup-grants-revoke-btn')).toBeDisabled();
    expect(getMock).toHaveBeenCalledTimes(3);
  });

  it('allows another revoke when the previous one left a retryable entry', async () => {
    postMock
      .mockResolvedValueOnce({
        data: { batchId: 'batch-1', results: [{ userId: rows[1].id, outcome: 'released', credits: 12 }] },
      })
      .mockResolvedValueOnce({
        data: { batchId: 'batch-1', results: [{ userId: rows[1].id, outcome: 'insufficient_balance', credits: 12 }] },
      });
    renderTab();
    fireEvent.click(await screen.findByTestId(`held-signup-grants-select-${rows[1].id}`));
    fireEvent.click(screen.getByTestId('held-signup-grants-release-btn'));
    fireEvent.click(await screen.findByTestId('held-signup-grants-revoke-btn'));
    fireEvent.click(await screen.findByTestId('held-signup-grants-revoke-confirm-btn'));
    expect(await screen.findByTestId('held-signup-grants-revoke-result')).toHaveTextContent('Revoked 0 of 1');
    await waitFor(() => expect(screen.getByTestId('held-signup-grants-revoke-btn')).not.toBeDisabled());
  });

  it('disables Next without a cursor', async () => {
    renderTab();
    await screen.findByTestId(`held-signup-grants-select-${rows[0].id}`);
    expect(screen.getByTestId('held-signup-grants-next')).toBeDisabled();
  });
});
