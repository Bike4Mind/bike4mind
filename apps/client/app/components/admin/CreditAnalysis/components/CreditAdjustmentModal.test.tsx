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
    const onCreditAdjustment = vi.fn().mockResolvedValue(true);
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

    fireEvent.change(screen.getByTestId('credit-adjust-reason-input'), {
      target: { value: 'Compensation for outage' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add Credits/i }));

    await waitFor(() => expect(onCreditAdjustment).toHaveBeenCalledTimes(1));
    expect(onCreditAdjustment).toHaveBeenCalledWith('user-1', { kind: 'delta', delta: 100 }, 'Compensation for outage');
  });

  it('disables the actions while a request is in flight so a double click submits once', async () => {
    let finish: () => void = () => {};
    const onCreditAdjustment = vi.fn(() => new Promise<boolean>(resolve => (finish = () => resolve(true))));
    const onClose = vi.fn();
    render(
      <TestWrapper>
        <CreditAdjustmentModal
          open
          onClose={onClose}
          selectedUser={selectedUser}
          onCreditAdjustment={onCreditAdjustment}
        />
      </TestWrapper>
    );

    fireEvent.change(screen.getByTestId('credit-adjust-reason-input'), { target: { value: 'Goodwill credit' } });
    const addButton = screen.getByTestId('credit-adjust-add-btn');
    fireEvent.click(addButton);
    fireEvent.click(addButton);

    expect(onCreditAdjustment).toHaveBeenCalledTimes(1);
    expect(addButton).toBeDisabled();
    expect(screen.getByTestId('credit-adjust-remove-btn')).toBeDisabled();

    expect(onClose).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('blocks add and remove until the reason is at least 5 characters', () => {
    const onCreditAdjustment = vi.fn().mockResolvedValue(true);
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

    const addButton = screen.getByTestId('credit-adjust-add-btn');
    const removeButton = screen.getByTestId('credit-adjust-remove-btn');
    expect(addButton).toBeDisabled();
    expect(removeButton).toBeDisabled();

    fireEvent.change(screen.getByTestId('credit-adjust-reason-input'), { target: { value: 'hey' } });
    expect(addButton).toBeDisabled();

    fireEvent.change(screen.getByTestId('credit-adjust-reason-input'), { target: { value: '  Goodwill credit ' } });
    expect(addButton).toBeEnabled();
    expect(removeButton).toBeEnabled();
    expect(onCreditAdjustment).not.toHaveBeenCalled();
  });

  it('sends the trimmed reason on removal', async () => {
    const onCreditAdjustment = vi.fn().mockResolvedValue(true);
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

    fireEvent.change(screen.getByTestId('credit-adjust-reason-input'), { target: { value: '  Refund reversal ' } });
    fireEvent.click(screen.getByRole('button', { name: /Remove Credits/i }));

    await waitFor(() => expect(onCreditAdjustment).toHaveBeenCalledTimes(1));
    expect(onCreditAdjustment).toHaveBeenCalledWith('user-1', { kind: 'delta', delta: -100 }, 'Refund reversal');
  });

  it('stays open with the reason intact when the adjustment is rejected', async () => {
    const onCreditAdjustment = vi.fn().mockResolvedValue(false);
    const onClose = vi.fn();
    render(
      <TestWrapper>
        <CreditAdjustmentModal
          open
          onClose={onClose}
          selectedUser={selectedUser}
          onCreditAdjustment={onCreditAdjustment}
        />
      </TestWrapper>
    );

    fireEvent.change(screen.getByTestId('credit-adjust-reason-input'), { target: { value: 'Refund reversal' } });
    fireEvent.click(screen.getByTestId('credit-adjust-remove-btn'));

    await waitFor(() => expect(screen.getByTestId('credit-adjust-remove-btn')).toBeEnabled());
    expect(onCreditAdjustment).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('credit-adjust-reason-input')).toHaveValue('Refund reversal');
  });

  describe('set balance mode', () => {
    const renderModal = (onCreditAdjustment = vi.fn().mockResolvedValue(true)) => {
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
      fireEvent.click(screen.getByTestId('credit-adjust-mode-set').querySelector('input') as HTMLInputElement);
      return onCreditAdjustment;
    };

    it('sets the balance to 0 with a valid reason from the footer button', async () => {
      const onCreditAdjustment = renderModal();
      const setBtn = screen.getByTestId('credit-adjust-set-btn');
      expect(setBtn).toBeDisabled();
      expect(screen.queryByTestId('credit-adjust-add-btn')).not.toBeInTheDocument();
      fireEvent.change(screen.getByTestId('credit-adjust-set-input'), { target: { value: '0' } });
      expect(screen.getByTestId('credit-adjust-set-preview')).toHaveTextContent('-100');

      fireEvent.change(screen.getByTestId('credit-adjust-reason-input'), { target: { value: 'Abusive signup' } });
      expect(setBtn).toBeEnabled();
      fireEvent.click(setBtn);

      await waitFor(() => expect(onCreditAdjustment).toHaveBeenCalledTimes(1));
      expect(onCreditAdjustment).toHaveBeenCalledWith('user-1', { kind: 'set', balance: 0 }, 'Abusive signup');
    });

    it('stays disabled when the balance input is cleared, instead of treating it as 0', () => {
      renderModal();
      fireEvent.change(screen.getByTestId('credit-adjust-set-input'), { target: { value: '0' } });
      fireEvent.change(screen.getByTestId('credit-adjust-reason-input'), { target: { value: 'Abusive signup' } });
      expect(screen.getByTestId('credit-adjust-set-btn')).toBeEnabled();
      fireEvent.change(screen.getByTestId('credit-adjust-set-input'), { target: { value: '' } });
      expect(screen.getByTestId('credit-adjust-set-btn')).toBeDisabled();
      expect(screen.getByTestId('credit-adjust-set-input')).not.toHaveAttribute('aria-invalid', 'true');
    });

    it('defaults the new balance to the current balance and stays disabled while they match', () => {
      renderModal();
      expect(screen.getByTestId('credit-adjust-set-input')).toHaveValue(100);
      fireEvent.change(screen.getByTestId('credit-adjust-reason-input'), { target: { value: 'Abusive signup' } });
      expect(screen.getByTestId('credit-adjust-set-btn')).toBeDisabled();
    });

    // The server sets against the live balance, which may have moved since the list loaded.
    it('allows setting the balance back to the list-load value once the admin enters it', async () => {
      const onCreditAdjustment = renderModal();
      fireEvent.change(screen.getByTestId('credit-adjust-reason-input'), { target: { value: 'Restore balance' } });
      fireEvent.change(screen.getByTestId('credit-adjust-set-input'), { target: { value: '' } });
      fireEvent.change(screen.getByTestId('credit-adjust-set-input'), { target: { value: '100' } });
      expect(screen.getByTestId('credit-adjust-set-preview')).toHaveTextContent('Same as the balance at list load');
      fireEvent.click(screen.getByTestId('credit-adjust-set-btn'));

      await waitFor(() => expect(onCreditAdjustment).toHaveBeenCalledTimes(1));
      expect(onCreditAdjustment).toHaveBeenCalledWith('user-1', { kind: 'set', balance: 100 }, 'Restore balance');
    });
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
