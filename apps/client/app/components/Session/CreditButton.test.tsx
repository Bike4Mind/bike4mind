import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { state } = vi.hoisted(() => ({ state: { enforceCredits: true, credits: 9982.6 } }));

// The real modal pulls react-query and the account chain; a stub that reveals its open state
// is enough to assert the chip opens it.
vi.mock('../subscription/CreditsModal', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="credits-modal-open" /> : null),
}));
vi.mock('@client/app/hooks/useEffectiveCredits', () => ({ useEffectiveCredits: () => state.credits }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => (key === 'enforceCredits' ? state.enforceCredits : undefined),
}));

import CreditBalanceChip from './CreditButton';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderChip = (props: { compact?: boolean } = {}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <CreditBalanceChip {...props} />
    </CssVarsProvider>
  );

describe('CreditBalanceChip', () => {
  beforeEach(() => {
    state.enforceCredits = true;
    state.credits = 9982.6;
  });

  it('shows a labeled balance that opens the credits modal', () => {
    renderChip();
    const chip = screen.getByTestId('credit-balance-chip');
    expect(chip).toHaveTextContent('9,982 credits');
    expect(screen.queryByTestId('credits-modal-open')).not.toBeInTheDocument();
    fireEvent.click(chip);
    expect(screen.getByTestId('credits-modal-open')).toBeInTheDocument();
  });

  it('keeps the full number in the accessible name when the visible label is compact', () => {
    renderChip({ compact: true });
    const chip = screen.getByTestId('credit-balance-chip');
    expect(chip).toHaveTextContent('10K credits');
    expect(chip).toHaveAttribute('aria-label', '9,982 credits. Open credits');
  });

  it('renders nothing while credits are not enforced', () => {
    state.enforceCredits = false;
    renderChip();
    expect(screen.queryByTestId('credit-balance-chip')).not.toBeInTheDocument();
  });
});
