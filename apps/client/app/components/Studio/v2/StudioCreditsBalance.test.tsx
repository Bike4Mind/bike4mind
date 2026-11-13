import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  enforceCredits: true as boolean,
  credits: 2310,
  threshold: 100,
  logEvent: vi.fn(),
}));

vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => (key === 'enforceCredits' ? h.enforceCredits : undefined),
}));
vi.mock('@client/app/hooks/useEffectiveCredits', () => ({ useEffectiveCredits: () => h.credits }));
vi.mock('@client/app/hooks/data/teamPlanSettings', () => ({ useLowCreditsThreshold: () => h.threshold }));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutate: h.logEvent }) }));
vi.mock('@client/app/components/subscription/BillingModal', () => ({
  default: ({ open, entry }: { open: boolean; entry: string }) =>
    open ? <div data-testid="billing-modal-stub" data-entry={entry} /> : null,
}));

import StudioThemeScope from '../design/StudioThemeScope';
import StudioCreditsBalance from './StudioCreditsBalance';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>
    <StudioThemeScope>{children}</StudioThemeScope>
  </CssVarsProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  h.enforceCredits = true;
  h.credits = 2310;
  h.threshold = 100;
});

describe('StudioCreditsBalance', () => {
  it('shows the balance in mono and opens the credits modal', () => {
    render(<StudioCreditsBalance />, { wrapper: Wrapper });
    expect(screen.getByTestId('studio-credits-balance-amount')).toHaveTextContent('2,310 credits');
    expect(screen.getByTestId('studio-credits-balance-amount')).toHaveAttribute('data-tone', 'default');
    fireEvent.click(screen.getByTestId('studio-credits-balance'));
    expect(screen.getByTestId('billing-modal-stub')).toHaveAttribute('data-entry', 'credits_chip');
    expect(h.logEvent).toHaveBeenCalledTimes(1);
  });

  it('turns warm below the low-credits threshold', () => {
    h.credits = 40;
    render(<StudioCreditsBalance />, { wrapper: Wrapper });
    expect(screen.getByTestId('studio-credits-balance-amount')).toHaveAttribute('data-tone', 'low');
  });

  it('renders nothing while credits are not enforced', () => {
    h.enforceCredits = false;
    render(<StudioCreditsBalance />, { wrapper: Wrapper });
    expect(screen.queryByTestId('studio-credits-balance')).not.toBeInTheDocument();
  });
});
