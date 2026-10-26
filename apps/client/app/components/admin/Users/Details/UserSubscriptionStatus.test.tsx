import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import UserSubscriptionStatus from './UserSubscriptionStatus';

const mocks = vi.hoisted(() => ({
  permissions: ['support:read'],
  remove: vi.fn(),
  confirm: vi.fn((options: { onOk: () => void }) => options.onOk()),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: Object.assign(
    (selector: (state: { currentUser: { isAdmin: boolean; adminPermissions: string[] } }) => unknown) =>
      selector({ currentUser: { isAdmin: false, adminPermissions: mocks.permissions } }),
    { getState: () => ({ currentUser: { isAdmin: false, adminPermissions: mocks.permissions } }) }
  ),
}));
vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGetUserSubscriptions: () => ({
    data: {
      individualSubscriptions: [
        { subscriptionId: 'sub-1', planName: 'Support plan', status: 'active', planCredits: 100 },
      ],
      teamSubscriptions: [],
      userCredits: 100,
    },
    isLoading: false,
    error: null,
  }),
  useRemoveSubscription: () => ({ mutate: mocks.remove }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({
  useConfirmation: () => mocks.confirm,
}));
vi.mock('./EditCreditsModal', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="credits-edit-modal" /> : null),
}));

const renderStatus = () =>
  render(
    <CssVarsProvider theme={extendTheme({ ...getThemeConfig() })}>
      <UserSubscriptionStatus user={{ id: 'target', name: 'Target' } as AdminUserListItem} />
    </CssVarsProvider>
  );

describe('delegated subscription actions', () => {
  it('lets a credits delegate edit and remove subscriptions without settings grants', () => {
    mocks.permissions = ['support:read', 'credits:adjust'];
    renderStatus();
    const edit = screen.getByTestId('edit-credits-sub-1');
    expect(edit).toBeEnabled();
    fireEvent.click(edit);
    expect(screen.getByTestId('credits-edit-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('remove-subscription-sub-1'));
    expect(mocks.remove).toHaveBeenCalledWith({ userId: 'target', subscriptionId: 'sub-1' });
  });
  it('keeps support lookup read-only with a missing credits permission state', () => {
    mocks.permissions = ['support:read'];
    renderStatus();
    expect(screen.getByTestId('edit-credits-sub-1')).toBeDisabled();
    expect(screen.getByTestId('remove-subscription-sub-1')).toBeDisabled();
    expect(screen.getByText('Missing permission: credits:adjust')).toBeInTheDocument();
  });
});

it('rechecks revoked credits access before accepting a saved subscription removal confirmation', () => {
  mocks.permissions = ['support:read', 'credits:adjust'];
  mocks.remove.mockClear();
  let pendingConfirm: (() => void) | undefined;
  mocks.confirm.mockImplementation(options => {
    pendingConfirm = options.onOk;
  });
  const view = renderStatus();
  fireEvent.click(screen.getByTestId('remove-subscription-sub-1'));
  expect(pendingConfirm).toBeDefined();
  mocks.permissions = ['support:read'];
  view.rerender(
    <CssVarsProvider theme={extendTheme({ ...getThemeConfig() })}>
      <UserSubscriptionStatus user={{ id: 'target', name: 'Target' } as AdminUserListItem} />
    </CssVarsProvider>
  );
  pendingConfirm?.();
  expect(mocks.remove).not.toHaveBeenCalled();
});
