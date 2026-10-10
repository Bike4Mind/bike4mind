import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ORGANIZATION_SUBSCRIPTION_PRICE_ID } from '@client/lib/subscriptions/constants';
import CreateTeamModal, { useCreateTeamModal } from './CreateTeamModal';

const mutateAsync = vi.fn();

vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useSubscribeTeamPlan: () => ({ mutateAsync: (...args: unknown[]) => mutateAsync(...args), isPending: false }),
  useCreateTeamDev: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

type PlansState = {
  data: Array<{ id: string; unit_amount: number }> | undefined;
  isLoading: boolean;
  isError: boolean;
};
const defaultPlans = (): PlansState => ({
  data: [{ id: ORGANIZATION_SUBSCRIPTION_PRICE_ID, unit_amount: 1000 }],
  isLoading: false,
  isError: false,
});
let plansState: PlansState = defaultPlans();

vi.mock('@client/app/hooks/data/stripe', () => ({
  useGetSubscriptionPlans: () => plansState,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('CreateTeamModal', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    plansState = defaultPlans();
    useCreateTeamModal.setState({ isOpen: true });
  });

  it('submits only once when Create Team is double-clicked rapidly', async () => {
    let resolveSubmit: (value: { sessionUrl: string }) => void = () => {};
    mutateAsync.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveSubmit = resolve;
        })
    );

    render(
      <TestWrapper>
        <CreateTeamModal />
      </TestWrapper>
    );

    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByPlaceholderText('Enter team name'), 'Rocket Squad');

    const submitButton = screen.getByRole('button', { name: /Create Team/i });
    submitButton.click();
    submitButton.click();

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));

    resolveSubmit({ sessionUrl: 'https://stripe.example/checkout' });
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  });

  const renderModal = () =>
    render(
      <TestWrapper>
        <CreateTeamModal />
      </TestWrapper>
    );

  it('shows the live per-seat price times the seat count', () => {
    renderModal();

    expect(screen.getByTestId('create-team-price-value').textContent).toBe('Total Price: $40/month');
  });

  it('blocks checkout instead of quoting $0 when the team price is missing from Stripe', async () => {
    plansState = { data: [{ id: 'price_some_other_plan', unit_amount: 3000 }], isLoading: false, isError: false };
    renderModal();

    expect(screen.getByTestId('create-team-price-error')).toBeTruthy();
    expect(screen.queryByTestId('create-team-price-value')).toBeNull();
    expect(screen.getByTestId('create-team-submit-btn').hasAttribute('disabled')).toBe(true);
  });

  it('does not sit on a loading skeleton forever when the plans query is disabled', () => {
    plansState = { data: undefined, isLoading: false, isError: false };
    renderModal();

    expect(screen.getByTestId('create-team-price-error')).toBeTruthy();
  });

  it('keeps a failed checkout request from escaping the click handler', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    mutateAsync.mockRejectedValue(new Error('stripe down'));
    renderModal();

    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByPlaceholderText('Enter team name'), 'Rocket Squad');
    await user.click(screen.getByTestId('create-team-submit-btn'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 0));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
