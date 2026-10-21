import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }),
}));
vi.mock('@client/app/hooks/data/credits', () => ({ useGetCreditTransactions: () => ({ data: [], isPending: false }) }));
vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGetSubscriptions: () => ({ data: [], isPending: false }),
}));
vi.mock('@client/app/hooks/data/stripe', () => ({ useGetSubscriptionPlans: () => ({ isLoading: false }) }));
vi.mock('@client/app/hooks/data/teamPlanSettings', () => ({ useLowCreditsThreshold: () => 10 }));
vi.mock('@client/app/hooks/useEffectiveCredits', () => ({ useEffectiveCredits: () => 100 }));
vi.mock('./CreditsSection', () => ({ CreditsSection: () => null }));
vi.mock('./PlansSection', () => ({ PlansSection: () => null, PlansSectionSkeleton: () => null }));

import CreditsModal from './CreditsModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('CreditsModal', () => {
  it('opens the unified Billing view at the credits section', () => {
    render(
      <TestWrapper>
        <CreditsModal open onClose={vi.fn()} />
      </TestWrapper>
    );
    expect(screen.getByTestId('billing-section-plans')).toBeInTheDocument();
    expect(screen.getByTestId('billing-section-credits-heading')).toHaveFocus();
  });

  it('renders nothing while closed', () => {
    render(
      <TestWrapper>
        <CreditsModal open={false} onClose={vi.fn()} />
      </TestWrapper>
    );
    expect(screen.queryByTestId('billing-modal')).not.toBeInTheDocument();
  });
});
