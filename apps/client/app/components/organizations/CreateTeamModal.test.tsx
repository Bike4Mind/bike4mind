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

vi.mock('@client/app/hooks/data/stripe', () => ({
  useGetSubscriptionPlans: () => ({
    data: [{ id: ORGANIZATION_SUBSCRIPTION_PRICE_ID, unit_amount: 1000 }],
    isLoading: false,
    isError: false,
  }),
}));

const seatLimits = vi.hoisted(() => ({ current: { minSeats: 3, maxSeats: 7 } }));
vi.mock('@client/app/hooks/data/teamPlanSettings', () => ({
  useTeamSeatLimits: () => seatLimits.current,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('CreateTeamModal', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    seatLimits.current = { minSeats: 3, maxSeats: 7 };
    useCreateTeamModal.setState({ isOpen: true });
  });

  it('shows the admin-configured seat range', () => {
    render(
      <TestWrapper>
        <CreateTeamModal />
      </TestWrapper>
    );

    expect(screen.getByText(/Team size must be between 3 and 7/)).toBeTruthy();
  });

  it('keeps the picked size inside a seat range that loads after mount', () => {
    const { rerender } = render(
      <TestWrapper>
        <CreateTeamModal />
      </TestWrapper>
    );
    expect(screen.getByText('3')).toBeTruthy();

    // Settings arrive with a higher floor than the default the modal was mounted with.
    seatLimits.current = { minSeats: 5, maxSeats: 7 };
    rerender(
      <TestWrapper>
        <CreateTeamModal />
      </TestWrapper>
    );
    expect(screen.getByText('5')).toBeTruthy();

    // ...and a ceiling below the current pick.
    seatLimits.current = { minSeats: 2, maxSeats: 2 };
    rerender(
      <TestWrapper>
        <CreateTeamModal />
      </TestWrapper>
    );
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText(/Total Price: \$20\/month/)).toBeTruthy();
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
});
