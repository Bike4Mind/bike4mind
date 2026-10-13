import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ORGANIZATION_SUBSCRIPTION_PRICE_ID } from '@client/lib/subscriptions/constants';
import { ExternalLinks } from '@client/app/utils/externalLinks';
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

const seatLimits = vi.hoisted(() => ({ current: { minSeats: 3, maxSeats: 7 } }));
vi.mock('@client/app/hooks/data/teamPlanSettings', () => ({
  useTeamSeatLimits: () => seatLimits.current,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const sizeValue = () => (screen.getByTestId('create-team-size-value') as HTMLInputElement).value;

describe('CreateTeamModal', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    plansState = defaultPlans();
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

  describe('with seat settings that change after mount', () => {
    afterEach(() => {
      seatLimits.current = { minSeats: 3, maxSeats: 7 };
    });

    it('keeps the picked size inside a seat range that loads after mount', () => {
      const { rerender } = render(
        <TestWrapper>
          <CreateTeamModal />
        </TestWrapper>
      );
      expect(sizeValue()).toBe('3');

      // Settings arrive with a higher floor than the default the modal was mounted with.
      seatLimits.current = { minSeats: 5, maxSeats: 7 };
      rerender(
        <TestWrapper>
          <CreateTeamModal />
        </TestWrapper>
      );
      expect(sizeValue()).toBe('5');

      // ...and a ceiling below the current pick.
      seatLimits.current = { minSeats: 2, maxSeats: 2 };
      rerender(
        <TestWrapper>
          <CreateTeamModal />
        </TestWrapper>
      );
      expect(sizeValue()).toBe('2');
      expect(screen.getByText(/Total Price: \$20\/month/)).toBeTruthy();
    });
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

    // Read the size back rather than assuming the seat floor, which the admin settings can move.
    const seats = Number(sizeValue());
    expect(seats).toBeGreaterThan(0);
    expect(screen.getByTestId('create-team-price-value').textContent).toBe(`Total Price: $${seats * 10}/month`);
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

  it('links custom billing to the sales contact in a new tab', () => {
    renderModal();
    const link = screen.getByTestId('create-team-contact-sales-link') as HTMLAnchorElement;

    expect(link.textContent).toBe('Contact us');
    expect(link.getAttribute('href')).toBe(ExternalLinks.support);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  describe('typing the seat count', () => {
    afterEach(() => {
      seatLimits.current = { minSeats: 3, maxSeats: 7 };
    });

    const typeSize = async (value: string) => {
      const user = userEvent.setup({ delay: null });
      const input = screen.getByTestId('create-team-size-value');
      await user.clear(input);
      if (value) await user.type(input, value);
      return { user, input };
    };

    it('accepts a typed seat count and prices it', async () => {
      seatLimits.current = { minSeats: 3, maxSeats: 50 };
      renderModal();
      const { user } = await typeSize('25');

      expect(sizeValue()).toBe('25');
      expect(screen.getByTestId('create-team-price-value').textContent).toBe('Total Price: $250/month');

      await user.type(screen.getByPlaceholderText('Enter team name'), 'Rocket Squad');
      await user.click(screen.getByTestId('create-team-submit-btn'));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ quantity: 25 })));
    });

    it.each([
      ['above the maximum', '99'],
      ['below the minimum', '1'],
    ])('flags a value %s and keeps Create Team disabled, even after blur', async (_name, text) => {
      renderModal();
      const user = userEvent.setup({ delay: null });
      await user.type(screen.getByPlaceholderText('Enter team name'), 'Rocket Squad');
      await typeSize(text);

      expect(screen.getByTestId('create-team-size-value-error').textContent).toBe('Must be between 3 and 7');
      expect(screen.getByTestId('create-team-submit-btn').hasAttribute('disabled')).toBe(true);

      await user.tab();
      expect(sizeValue()).toBe(text);
      expect(screen.getByTestId('create-team-submit-btn').hasAttribute('disabled')).toBe(true);
    });

    it('does not submit an out-of-range size while the field is still focused', async () => {
      renderModal();
      const user = userEvent.setup({ delay: null });
      await user.type(screen.getByPlaceholderText('Enter team name'), 'Rocket Squad');
      await typeSize('99');
      fireEvent.click(screen.getByTestId('create-team-submit-btn'));

      expect(mutateAsync).not.toHaveBeenCalled();
    });

    it('keeps the total on the last valid size while the draft is invalid', async () => {
      renderModal();
      await typeSize('99');

      expect(screen.getByTestId('create-team-price-value').textContent).toBe('Total Price: $30/month');
    });

    it('rounds a fractional value to an integer on blur', async () => {
      renderModal();
      const { user } = await typeSize('5.4');
      await user.tab();

      expect(sizeValue()).toBe('5');
    });

    it('disables Create Team while the field is empty', async () => {
      renderModal();
      const user = userEvent.setup({ delay: null });
      await user.type(screen.getByPlaceholderText('Enter team name'), 'Rocket Squad');
      expect(screen.getByTestId('create-team-submit-btn').hasAttribute('disabled')).toBe(false);

      await typeSize('');
      expect(sizeValue()).toBe('');
      expect(screen.getByTestId('create-team-submit-btn').hasAttribute('disabled')).toBe(true);
    });
  });
});
