import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ICreditTransaction } from '@bike4mind/common';

const { navigate, account } = vi.hoisted(() => ({
  navigate: vi.fn(),
  account: { selectedAccount: null as null | { personal: boolean } },
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => {
      if (typeof fallback === 'string') return fallback;
      if (fallback && typeof fallback === 'object' && 'defaultValue' in fallback) {
        const opts = fallback as Record<string, string>;
        return opts.defaultValue.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => opts[name] ?? '');
      }
      return key;
    },
  }),
}));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({ useSelectedAccount: () => account }));
vi.mock('../Credits/PaymentButton', () => ({
  default: ({ label, packageId }: { label: ReactNode; packageId: string }) => (
    <button type="button" data-testid="credits-purchase-btn" data-package={packageId}>
      {label}
    </button>
  ),
}));

import { CreditsSection } from './CreditsSection';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderSection = (props: Partial<Parameters<typeof CreditsSection>[0]> = {}) =>
  render(
    <TestWrapper>
      <CreditsSection transactions={[]} onClose={vi.fn()} {...props} />
    </TestWrapper>
  );

describe('CreditsSection', () => {
  beforeEach(() => {
    navigate.mockClear();
    account.selectedAccount = null;
  });

  it('closes the modal and opens the profile usage tab from the usage link', () => {
    const onClose = vi.fn();
    renderSection({ onClose });
    fireEvent.click(screen.getByTestId('credits-modal-see-usage-link'));
    expect(onClose).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ to: '/profile', search: { tab: 'usage' } });
  });

  it('starts on the $20 pack, not the middle one', () => {
    renderSection();
    expect(screen.getByTestId('credits-purchase-btn')).toHaveAttribute('data-package', 'package_25k');
    expect(screen.getByRole('radio', { name: /33,333/ })).toBeChecked();
  });

  it('has one purchase button that buys the selected pack', () => {
    renderSection();
    const buy = screen.getByTestId('credits-purchase-btn');
    expect(screen.getAllByTestId('credits-purchase-btn')).toHaveLength(1);
    expect(buy).toHaveAttribute('data-package', 'package_25k');
    expect(buy).toHaveTextContent('Buy 33,333 credits for $20');

    fireEvent.click(screen.getByRole('radio', { name: /83,333/ }));
    expect(screen.getByTestId('credits-purchase-btn')).toHaveAttribute('data-package', 'package_usd50');
    expect(screen.getByTestId('credits-purchase-btn')).toHaveTextContent('Buy 83,333 credits for $50');

    fireEvent.click(screen.getByRole('radio', { name: /166,667/ }));
    expect(screen.getByTestId('credits-purchase-btn')).toHaveAttribute('data-package', 'package_usd100');
    expect(screen.getByTestId('credits-purchase-btn')).toHaveTextContent('Buy 166,667 credits for $100');
  });

  it('card radios are not pinned to a fixed input size by global styles', () => {
    // jsdom cannot resolve CSS hit areas; a fixed size on the global radio input rule shrinks the
    // overlay input of card radios to a corner, so assert the stylesheet never pins one.
    const globalCss = readFileSync(resolve(__dirname, '../../globals.css'), 'utf8');
    const rule = globalCss.match(/\[class\*='MuiRadio-input'\]\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).not.toMatch(/(^|[\s;])(width|height|min-width|min-height|max-width|max-height)\s*:/);
  });

  it('renders each pack as an overlay radio inside its card', () => {
    renderSection();
    for (const id of ['package_25k', 'package_usd50', 'package_usd100']) {
      const card = screen.getByTestId(`credits-pack-${id}`);
      const input = card.querySelector('input[type="radio"]') as HTMLInputElement;
      expect(input).not.toBeNull();
      // Joy's overlay action span is the radio's positioned ancestor and stretches over the card.
      expect(input.parentElement?.className).toMatch(/MuiRadio-action/);
      expect(card.querySelectorAll('input[type="radio"]')).toHaveLength(1);
    }
  });

  it('marks each pack credit count with the decorative credit icon', () => {
    renderSection();
    for (const id of ['package_25k', 'package_usd50', 'package_usd100']) {
      const icon = screen.getByTestId(`credits-pack-${id}-icon`);
      expect(screen.getByTestId(`credits-pack-${id}`)).toContainElement(icon);
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    }
    // Decorative: the radio's accessible name is still the number and "credits".
    expect(screen.getByRole('radio', { name: /166,667\s*credits/ })).toBeInTheDocument();
  });

  it('states the per-1,000 rate computed from the packs, with no best-value badge', () => {
    renderSection();
    expect(screen.getByTestId('credits-pack-rate')).toHaveTextContent(
      'Every pack is the same rate: $0.60 per 1,000 credits.'
    );
    expect(screen.queryByText(/best value/i)).not.toBeInTheDocument();
  });

  it('replaces the packs with an explanation on an organization account', () => {
    account.selectedAccount = { personal: false };
    renderSection();
    expect(screen.queryByTestId('credits-purchase-btn')).not.toBeInTheDocument();
    expect(screen.getByText('Organization Credits Active')).toBeInTheDocument();
  });

  it('lists purchases only, and shows placeholders while they load', () => {
    // 16,667 credits for $10 is a retired pack: history renders from the ledger row, not the pack table.
    const purchase = {
      id: 't1',
      type: 'purchase',
      credits: 16667,
      amount: 1000,
      status: 'completed',
      createdAt: new Date('2026-03-02T12:00:00Z'),
    } as unknown as ICreditTransaction;
    const usage = { id: 't2', type: 'generic_text', credits: 5 } as unknown as ICreditTransaction;
    const { unmount } = renderSection({ transactions: [purchase, usage] });
    expect(screen.getAllByText(/16,667 credits/)).toHaveLength(1);
    expect(screen.getByText('$10.00')).toBeInTheDocument();
    unmount();

    renderSection({ transactionsLoading: true });
    expect(screen.queryByText('credits_modal.no_transactions')).not.toBeInTheDocument();
  });
});
