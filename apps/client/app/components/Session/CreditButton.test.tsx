import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { state } = vi.hoisted(() => ({
  state: { enforceCredits: true, credits: 9982.6, payerNote: null as string | null },
}));

// The real modal pulls react-query and the account chain; a stub that reveals its open state
// is enough to assert the chip opens it.
vi.mock('../subscription/CreditsModal', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="credits-modal-open" /> : null),
}));
vi.mock('@client/app/hooks/useEffectiveCredits', () => ({ useEffectiveCredits: () => state.credits }));
vi.mock('./CreditPayerNote', () => ({ useCreditPayerNote: () => state.payerNote }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => (key === 'enforceCredits' ? state.enforceCredits : undefined),
}));

import CreditBalanceChip from './CreditButton';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderChip = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <CreditBalanceChip />
    </CssVarsProvider>
  );

describe('CreditBalanceChip', () => {
  beforeEach(() => {
    state.enforceCredits = true;
    state.credits = 9982.6;
    state.payerNote = null;
  });

  it('shows a labeled balance that opens the credits modal', () => {
    renderChip();
    const chip = screen.getByTestId('credit-balance-chip');
    expect(chip).toHaveTextContent('9,982 credits');
    expect(within(chip).getByTestId('credit-icon')).toBeInTheDocument();
    expect(screen.queryByTestId('credits-modal-open')).not.toBeInTheDocument();
    fireEvent.click(chip);
    expect(screen.getByTestId('credits-modal-open')).toBeInTheDocument();
  });

  it('shows the full balance, with the same number in the accessible name', () => {
    state.credits = 124_560;
    renderChip();
    const chip = screen.getByTestId('credit-balance-chip');
    expect(chip).toHaveTextContent('124,560 credits');
    expect(chip).toHaveAttribute('aria-label', '124,560 credits. Open credits');
  });

  it('renders nothing while credits are not enforced', () => {
    state.enforceCredits = false;
    renderChip();
    expect(screen.queryByTestId('credit-balance-chip')).not.toBeInTheDocument();
  });

  it('marks the balance with who pays in a notebook the user does not own, first in its tooltip', async () => {
    state.payerNote = "Paid from your balance, not the owner's";
    renderChip();
    const chip = screen.getByTestId('credit-balance-chip');
    expect(within(chip).getByTestId('credit-payer-mark')).toBeInTheDocument();
    expect(chip).toHaveAttribute('aria-label', "9,982 credits. Paid from your balance, not the owner's. Open credits");
    fireEvent.mouseOver(chip);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/^Paid from your balance, not the owner's/);
  });

  it('has no mark in a notebook the user owns', () => {
    renderChip();
    expect(screen.queryByTestId('credit-payer-mark')).toBeNull();
  });
});
