import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { state, logEvent } = vi.hoisted(() => ({
  state: { enforceCredits: true, credits: 9982.6, payerNote: null as string | null, model: 'model-a', compact: false },
  logEvent: vi.fn(),
}));

vi.mock('../subscription/BillingModal', () => ({
  default: ({ open, entry }: { open: boolean; entry?: string }) =>
    open ? <div data-testid="billing-open" data-entry={entry} /> : null,
}));
vi.mock('@client/app/hooks/useEffectiveCredits', () => ({ useEffectiveCredits: () => state.credits }));
vi.mock('./CreditPayerNote', () => ({ useCreditPayerNote: () => state.payerNote }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => (key === 'enforceCredits' ? state.enforceCredits : undefined),
}));
vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (value: { model: string }) => unknown) => selector({ model: state.model }),
}));
vi.mock('./SessionBottom/ComposerStatusLine', () => ({
  STATUS_ITEM_HEIGHT: 24,
  useStatusLineCompact: () => state.compact,
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
      {
        id: 'model-free',
        name: 'Free Model',
        type: 'text',
        backend: 'openai',
        freeToRun: true,
        pricing: { 1000000: { input: 0.000001, output: 0.000004 } },
      },
    ],
  }),
}));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutate: logEvent }) }));

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
    state.compact = false;
    logEvent.mockClear();
  });

  it('shows answers as the primary unit and opens Billing directly with chip attribution', () => {
    renderChip();
    const chip = screen.getByTestId('credit-balance-chip');
    expect(chip).toHaveTextContent(/answers/);
    expect(within(chip).getByTestId('credit-icon')).toBeInTheDocument();
    expect(screen.queryByTestId('billing-open')).not.toBeInTheDocument();
    fireEvent.click(chip);
    expect(screen.getByTestId('billing-open')).toHaveAttribute('data-entry', 'credits_chip');
    expect(logEvent).toHaveBeenCalledWith({ type: 'credits_chip_clicked' });
  });

  it('keeps credits secondary in the accessible explanation', () => {
    state.credits = 124_560;
    renderChip();
    const chip = screen.getByTestId('credit-balance-chip');
    expect(chip).not.toHaveTextContent('credits');
    expect(chip).toHaveAccessibleName(/124,560 credits.*See plans and top up/);
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

  it('marks the count as approximate', () => {
    renderChip();
    expect(screen.getByTestId('credit-balance-chip').textContent).toMatch(/^~[\d,]+ answers$/);
    expect(screen.getByTestId('credit-balance-chip')).toHaveAccessibleName(
      /about [\d,]+ typical answers left on Model A/
    );
  });

  it('says 0 answers at a zero or negative balance', () => {
    state.credits = 0;
    const { unmount } = renderChip();
    expect(screen.getByTestId('credit-balance-chip')).toHaveTextContent(/^0 answers$/);
    expect(screen.getByTestId('credit-balance-chip')).toHaveAccessibleName('No credits left. See plans and top up');
    unmount();
    state.credits = -5;
    renderChip();
    expect(screen.getByTestId('credit-balance-chip')).toHaveTextContent(/^0 answers$/);
  });

  it('says <1 answer when the balance is positive but buys less than one', () => {
    state.credits = 1;
    renderChip();
    expect(screen.getByTestId('credit-balance-chip')).toHaveTextContent(/^<1 answer$/);
  });

  it('shortens every count in compact mode, including 1, <1 and 0', () => {
    state.compact = true;
    const cases: [number, RegExp][] = [
      [9982.6, /^~[\d,]+$/],
      [1, /^<1$/],
      [0, /^0$/],
    ];
    for (const [credits, pattern] of cases) {
      state.credits = credits;
      const { unmount } = renderChip();
      expect(screen.getByTestId('credit-balance-chip').textContent).toMatch(pattern);
      unmount();
    }
  });

  it('shortens a single answer in compact mode', () => {
    state.compact = true;
    state.credits = 25;
    renderChip();
    expect(screen.getByTestId('credit-balance-chip')).toHaveTextContent(/^~1$/);
  });

  it('uses the singular for a single answer', () => {
    state.credits = 25;
    renderChip();
    expect(screen.getByTestId('credit-balance-chip')).toHaveTextContent(/^~1 answer$/);
  });

  it('falls back to credits only, without a repeated clause, for a free model', () => {
    state.model = 'model-free';
    renderChip();
    const chip = screen.getByTestId('credit-balance-chip');
    expect(chip).not.toHaveTextContent(/answer/);
    expect(chip).toHaveAccessibleName(/^9,98\d credits left on Free Model\. See plans and top up$/);
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
    expect(chip).toHaveAccessibleName(/Paid from your balance, not the owner's.*See plans and top up/);
    fireEvent.mouseOver(chip);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/^Paid from your balance, not the owner's/);
  });

  it('has no mark in a notebook the user owns', () => {
    renderChip();
    expect(screen.queryByTestId('credit-payer-mark')).toBeNull();
  });

  it('offers a direct purchase from the low-balance tooltip', async () => {
    state.credits = 1;
    renderChip();
    fireEvent.mouseOver(screen.getByTestId('credit-balance-chip'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Subscribe or top up');
  });
});
