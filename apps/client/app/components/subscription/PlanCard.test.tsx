import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import PlanCard from './PlanCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderCard = (hasPaymentIssue: boolean) =>
  render(
    <TestWrapper>
      <PlanCard
        name="Professional"
        description="desc"
        features={['one']}
        price={15}
        interval="month"
        isCurrentPlan
        hasPaymentIssue={hasPaymentIssue}
        currentPlanDetails={{ periodEndsAt: new Date('2026-02-01T00:00:00Z'), canceledAt: null }}
        priceId="price_pro"
        actionButton={<button type="button">action</button>}
      />
    </TestWrapper>
  );

describe('PlanCard', () => {
  it('says the payment failed instead of when the plan renews', () => {
    // A delinquent plan still has a period end on paper, so "renews on" would read as
    // healthy - the user needs the reason their card was declined.
    renderCard(true);

    expect(screen.getByText('subscriptions.payment_issue')).toBeInTheDocument();
    expect(screen.queryByText('subscription_modal.subscription_renewal')).not.toBeInTheDocument();
  });

  it('shows the renewal date for a plan in good standing', () => {
    renderCard(false);

    expect(screen.getByText('subscription_modal.subscription_renewal')).toBeInTheDocument();
    expect(screen.queryByText('subscriptions.payment_issue')).not.toBeInTheDocument();
  });
});
