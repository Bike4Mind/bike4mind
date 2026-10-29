import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  userSubscriptions: vi.fn(),
  seatLimits: vi.fn(),
}));

vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGrantSubscription: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
  useGetUserSubscriptions: mocks.userSubscriptions,
}));
vi.mock('@client/app/hooks/data/stripe', () => ({
  useGetSubscriptionPlans: () => ({ data: SUBSCRIPTION_PLANS.map(plan => ({ id: plan.priceId, active: true })) }),
}));
vi.mock('@client/app/hooks/data/teamPlanSettings', () => ({
  useTeamSeatLimits: mocks.seatLimits,
  useTeamCreditsPerSeat: () => 1000,
}));
vi.mock('./UserSelector', () => ({
  default: ({ onChange }: { onChange: (id: string | null) => void }) => (
    <button type="button" data-testid="user-selector-pick-btn" onClick={() => onChange('billing-owner')}>
      Pick billing owner
    </button>
  ),
}));

import GrantSubscriptionModal from './GrantSubscriptionModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const user = { id: 'user-1', name: 'Ada Lovelace', currentCredits: 250 } as AdminUserListItem;
const plan = SUBSCRIPTION_PLANS[0];

const renderModal = () => {
  const onClose = vi.fn();
  const view = render(<GrantSubscriptionModal user={user} open onClose={onClose} />, { wrapper: TestWrapper });
  return { onClose, view };
};

const choose = async (selectTestId: string, optionName: RegExp | string) => {
  await userEvent.click(within(screen.getByTestId(selectTestId)).getByRole('combobox'));
  await userEvent.click(await screen.findByRole('option', { name: optionName }));
};

const pickPreset = () => fireEvent.click(screen.getByTestId('grant-subscription-reason-input-preset-0'));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutateAsync.mockResolvedValue({ success: true, message: 'ok' });
  mocks.userSubscriptions.mockReturnValue({ data: { individualSubscriptions: [], teamSubscriptions: [] } });
  mocks.seatLimits.mockReturnValue({ minSeats: 2, maxSeats: 10 });
});

const fillTeamGrant = async () => {
  await choose('grant-subscription-type-select', 'Team Plan');
  fireEvent.change(screen.getByTestId('grant-subscription-org-name-input'), { target: { value: 'Acme' } });
};

describe('GrantSubscriptionModal', () => {
  it('blocks the commit until a plan is chosen, then until a reason is given, each explained in place', async () => {
    renderModal();
    const confirm = screen.getByTestId('grant-subscription-dialog-confirm-btn');

    expect(confirm).toBeDisabled();
    expect(screen.getByTestId('grant-subscription-dialog-hint')).toHaveTextContent('Select a plan to grant.');

    await choose('grant-subscription-plan-select', new RegExp(plan.name));
    expect(screen.getByTestId('grant-subscription-dialog-hint')).toHaveTextContent('Pick a reason');

    pickPreset();
    expect(confirm).toBeEnabled();
  });

  it('previews the plan and its credits and grants an individual plan for the chosen months', async () => {
    const { onClose } = renderModal();
    await choose('grant-subscription-plan-select', new RegExp(plan.name));
    await choose('grant-subscription-duration-select', '3 months');

    const credits = `+${(plan.credits * 3).toLocaleString()} credits`;
    expect(screen.getByTestId('grant-subscription-preview-after')).toHaveTextContent(plan.name);
    expect(screen.getByTestId('grant-subscription-preview-after')).toHaveTextContent(credits);
    expect(screen.getByTestId('grant-subscription-preview-before')).toHaveTextContent('No plan');

    pickPreset();
    const confirm = screen.getByTestId('grant-subscription-dialog-confirm-btn');
    expect(confirm).toHaveTextContent('Grant 3 months');
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith({
        userId: 'user-1',
        subscriptionType: 'individual',
        priceId: plan.priceId,
        durationMonths: 3,
        reason: 'Pilot or partner access',
      })
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('requires an organization name for a team grant and submits seats times credits per seat', async () => {
    renderModal();
    await choose('grant-subscription-type-select', 'Team Plan');
    expect(screen.getByTestId('grant-subscription-dialog-hint')).toHaveTextContent('Enter an organization name.');

    fireEvent.change(screen.getByTestId('grant-subscription-org-name-input'), { target: { value: '  Acme  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'More seats' }));
    pickPreset();

    expect(screen.getByTestId('grant-subscription-preview-after')).toHaveTextContent('+3,000 credits');
    fireEvent.click(screen.getByTestId('grant-subscription-dialog-confirm-btn'));

    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith({
        userId: 'user-1',
        subscriptionType: 'team',
        seats: 3,
        organizationName: 'Acme',
        durationMonths: 1,
        billingOwnerId: undefined,
        reason: 'Pilot or partner access',
      })
    );
  });

  it("previews the user's current plan as the before state", () => {
    mocks.userSubscriptions.mockReturnValue({
      data: { individualSubscriptions: [{ id: 's1', planName: 'Pro' }], teamSubscriptions: [] },
    });
    renderModal();
    expect(screen.getByTestId('grant-subscription-preview-before')).toHaveTextContent('Pro');
  });

  it('sends the selected billing owner with a team grant', async () => {
    renderModal();
    await fillTeamGrant();
    fireEvent.click(screen.getByTestId('user-selector-pick-btn'));
    pickPreset();
    fireEvent.click(screen.getByTestId('grant-subscription-dialog-confirm-btn'));

    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ billingOwnerId: 'billing-owner' }))
    );
  });

  it('blocks a team grant when the seat settings put the minimum above the maximum', async () => {
    mocks.seatLimits.mockReturnValue({ minSeats: 5, maxSeats: 3 });
    renderModal();
    await fillTeamGrant();
    pickPreset();
    expect(screen.getByTestId('grant-subscription-dialog-confirm-btn')).toBeDisabled();
    expect(screen.getByTestId('grant-subscription-dialog-hint')).toHaveTextContent('at least 5 seats');
  });

  it('resets the form when closed', async () => {
    const { onClose, view } = renderModal();
    await fillTeamGrant();
    fireEvent.click(screen.getByTestId('grant-subscription-dialog-cancel-btn'));
    expect(onClose).toHaveBeenCalled();

    view.rerender(<GrantSubscriptionModal user={user} open onClose={onClose} />);
    expect(screen.queryByTestId('grant-subscription-org-name-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('grant-subscription-dialog-hint')).toHaveTextContent('Select a plan to grant.');
  });

  it('stays open when the grant is rejected', async () => {
    mocks.mutateAsync.mockRejectedValue(new Error('boom'));
    const { onClose } = renderModal();
    await choose('grant-subscription-plan-select', new RegExp(plan.name));
    pickPreset();
    fireEvent.click(screen.getByTestId('grant-subscription-dialog-confirm-btn'));

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('grant-subscription-dialog')).toBeInTheDocument();
  });
});
