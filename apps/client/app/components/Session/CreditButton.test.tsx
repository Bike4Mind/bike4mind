import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { state } = vi.hoisted(() => ({
  state: { enforceCredits: true, credits: 9982.6, payerNote: null as string | null, model: 'model-a' },
}));

vi.mock('../subscription/CreditsExplanationModal', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="credits-explanation-open" /> : null),
}));
vi.mock('@client/app/hooks/useEffectiveCredits', () => ({ useEffectiveCredits: () => state.credits }));
vi.mock('./CreditPayerNote', () => ({ useCreditPayerNote: () => state.payerNote }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => (key === 'enforceCredits' ? state.enforceCredits : undefined),
}));
vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (value: { model: string }) => unknown) => selector({ model: state.model }),
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({
    data: [
      {
        id: 'model-a',
        name: 'Model A',
        type: 'text',
        backend: 'openai',
        pricing: { 1000000: { input: 0.000001, output: 0.000004 } },
      },
      {
        id: 'model-b',
        name: 'Model B',
        type: 'text',
        backend: 'openai',
        pricing: { 1000000: { input: 0.000002, output: 0.000008 } },
      },
    ],
  }),
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
    state.model = 'model-a';
  });

  it('shows answers as the primary unit and opens the explanation instead of Billing', () => {
    renderChip();
    const chip = screen.getByTestId('credit-balance-chip');
    expect(chip).toHaveTextContent(/answers/);
    expect(within(chip).getByTestId('credit-icon')).toBeInTheDocument();
    expect(screen.queryByTestId('credits-explanation-open')).not.toBeInTheDocument();
    fireEvent.click(chip);
    expect(screen.getByTestId('credits-explanation-open')).toBeInTheDocument();
  });

  it('keeps credits secondary in the accessible explanation', () => {
    state.credits = 124_560;
    renderChip();
    const chip = screen.getByTestId('credit-balance-chip');
    expect(chip).not.toHaveTextContent('credits');
    expect(chip).toHaveAccessibleName(/124,560 credits.*Learn about credits/);
  });

  it('recomputes answers left when the selected model changes', () => {
    const { rerender } = renderChip();
    const first = screen.getByTestId('credit-balance-chip').textContent;
    state.model = 'model-b';
    rerender(
      <CssVarsProvider theme={appTheme}>
        <CreditBalanceChip />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('credit-balance-chip').textContent).not.toBe(first);
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
    expect(chip).toHaveAccessibleName(/Paid from your balance, not the owner's.*Learn about credits/);
    fireEvent.mouseOver(chip);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/^Paid from your balance, not the owner's/);
  });

  it('has no mark in a notebook the user owns', () => {
    renderChip();
    expect(screen.queryByTestId('credit-payer-mark')).toBeNull();
  });
});
