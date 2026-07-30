import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';

const mockGet = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...a: unknown[]) => mockGet(...a) },
}));

import { CreditAdjustmentModal } from './CreditAdjustmentModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
};

const selectedUser = { id: 'user-1', fullName: 'Ada Lovelace', email: 'ada@example.com', currentCredits: 100 };

describe('CreditAdjustmentModal — reason threading + audit trail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: { rows: [] } });
  });

  it('threads the typed reason through onCreditAdjustment when adding credits', async () => {
    const onCreditAdjustment = vi.fn().mockResolvedValue(undefined);
    render(
      <TestWrapper>
        <CreditAdjustmentModal
          open
          onClose={() => {}}
          selectedUser={selectedUser}
          onCreditAdjustment={onCreditAdjustment}
        />
      </TestWrapper>
    );

    fireEvent.change(screen.getByPlaceholderText(/Reason for adjustment/i), {
      target: { value: 'Compensation for outage' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add Credits/i }));

    await waitFor(() => expect(onCreditAdjustment).toHaveBeenCalledTimes(1));
    expect(onCreditAdjustment).toHaveBeenCalledWith('user-1', 100, 100, 'Compensation for outage');
  });

  it('passes an undefined reason (not an empty string) when the note is blank on removal', async () => {
    const onCreditAdjustment = vi.fn().mockResolvedValue(undefined);
    render(
      <TestWrapper>
        <CreditAdjustmentModal
          open
          onClose={() => {}}
          selectedUser={selectedUser}
          onCreditAdjustment={onCreditAdjustment}
        />
      </TestWrapper>
    );

    fireEvent.click(screen.getByRole('button', { name: /Remove Credits/i }));

    await waitFor(() => expect(onCreditAdjustment).toHaveBeenCalledTimes(1));
    expect(onCreditAdjustment).toHaveBeenCalledWith('user-1', 100, -100, undefined);
  });

  it('renders the audit trail of recent adjustments', async () => {
    mockGet.mockResolvedValue({
      data: {
        rows: [
          {
            id: 'tx-1',
            createdAt: new Date('2026-07-01T12:00:00Z').toISOString(),
            credits: 50,
            description: 'Promo bonus',
            actorName: 'Admin One',
            resultingBalance: 150,
          },
        ],
      },
    });

    render(
      <TestWrapper>
        <CreditAdjustmentModal open onClose={() => {}} selectedUser={selectedUser} onCreditAdjustment={vi.fn()} />
      </TestWrapper>
    );

    await waitFor(() => expect(screen.getByText('Promo bonus')).toBeInTheDocument());
    expect(screen.getByText(/by Admin One/)).toBeInTheDocument();
    expect(screen.getByText('+50')).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/api/admin/users/user-1/credit-transactions');
  });
});
