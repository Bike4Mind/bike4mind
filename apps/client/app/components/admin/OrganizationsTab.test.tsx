import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', async () => (await import('./__tests__/fakeAdminRouter')).fakeRouterModule);

const { useSearchOrganizationsMock, useAdminOrgGrantsMock, useAdjustOrgSeatsMock, actions } = vi.hoisted(() => ({
  actions: { create: vi.fn(), grant: vi.fn(), topup: vi.fn(), convert: vi.fn(), revoke: vi.fn() },
  useSearchOrganizationsMock: vi.fn(),
  useAdminOrgGrantsMock: vi.fn(),
  useAdjustOrgSeatsMock: vi.fn(),
}));

vi.mock('@client/app/hooks/data/organizations', () => ({
  useSearchOrganizations: useSearchOrganizationsMock,
  useCreateOrganization: () => usePendingMutation(actions.create),
}));
vi.mock('@client/app/hooks/data/adminOrganizations', () => ({
  useAdjustOrgSeats: useAdjustOrgSeatsMock,
  useAdminOrgGrants: useAdminOrgGrantsMock,
  useConvertOrgToPaid: () => ({ mutateAsync: actions.convert, isPending: false }),
  useGrantOrganization: () => usePendingMutation(actions.grant),
  useRevokeOrganization: () => ({ mutateAsync: actions.revoke, isPending: false }),
  useTopUpOrganization: () => ({ mutateAsync: actions.topup, isPending: false }),
}));
vi.mock('@client/app/hooks/data/user', () => ({ useGetPendingOrganizationUsers: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/data/teamPlanSettings', () => ({ useTeamSeatLimits: () => ({ maxSeats: 100 }) }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/Member', () => ({ default: () => null }));
vi.mock('./OrganizationProfileModal', () => ({ default: () => null }));

import { fakeAdminRouter } from './__tests__/fakeAdminRouter';
import OrganizationsTab from './OrganizationsTab';
import { toast } from 'sonner';
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
import { openInNewTab } from '@client/app/utils/externalLinks';
vi.mock('@client/app/utils/externalLinks', () => ({ openInNewTab: vi.fn() }));
import { DEFAULT_ORGANIZATIONS_PARAMS } from './organizationsTabSearch';
import { useOrganizationsTab } from './useOrganizationsTabParams';
import { AdminCommandPalette } from './shared/AdminCommandPalette';
import { useSubscriptionsTab } from './Subscriptions/useSubscriptionsTabParams';
import { CLEARED_FILTER_PARAMS } from './Subscriptions/subscriptionsTabSearch';
import { ADMIN_SUBSCRIPTIONS_TAB_SLUG } from './Subscriptions/Detail/subscriptionDetailModel';
import { UndoToastProvider } from './shared/UndoToast';

const usePendingMutation = (action: (...args: unknown[]) => Promise<unknown>) => {
  const [isPending, setIsPending] = useState(false);
  return {
    isPending,
    mutateAsync: async (...args: unknown[]) => {
      setIsPending(true);
      try {
        return await action(...args);
      } finally {
        setIsPending(false);
      }
    },
  };
};

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ORG_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const appTheme = extendTheme({ ...getThemeConfig() });

const organization = (id: string, name: string) => ({
  id,
  name,
  personal: false,
  users: [],
  userId: 'owner',
  seats: 4,
  currentCredits: 0,
});

const mockList = (overrides: Record<string, unknown> = {}) =>
  useSearchOrganizationsMock.mockReturnValue({
    data: {
      data: [organization(ORG_A, 'Alpha Org'), organization(ORG_B, 'Beta Org')],
      totalOrganizations: 20,
      totalPages: 2,
    },
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
    ...overrides,
  });

const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <UndoToastProvider>
        <OrganizationsTab />
      </UndoToastProvider>
    </CssVarsProvider>
  );

beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.info).mockClear();
  vi.mocked(openInNewTab).mockClear();
  for (const mutation of Object.values(actions)) mutation.mockReset().mockResolvedValue({});
  localStorage.removeItem('admin-organizations-tab-01');
  useSearchOrganizationsMock.mockReset();
  mockList();
  useAdminOrgGrantsMock.mockReturnValue({ data: [] });
  useAdjustOrgSeatsMock.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({ seats: 6 }), isPending: false });
  act(() => {
    useOrganizationsTab.setState({ params: { ...DEFAULT_ORGANIZATIONS_PARAMS } });
    fakeAdminRouter.reset({ tab: 'organizations', orgsPage: 1 });
  });
});

describe('OrganizationsTab', () => {
  it('focuses the real Organizations search with /', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <div data-admin-surface>
          <AdminCommandPalette />
          <UndoToastProvider>
            <OrganizationsTab />
          </UndoToastProvider>
        </div>
      </CssVarsProvider>
    );
    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.getByTestId('admin-organizations-search-input')).toHaveFocus();
  });

  it('replace-navigates a page past the end back to the last page in a single navigate', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgsPage: 9 }));
    renderTab();

    expect(fakeAdminRouter.search).toMatchObject({ tab: 'organizations', orgsPage: 2 });
    expect(fakeAdminRouter.navigate).toHaveBeenCalledTimes(1);
    expect(fakeAdminRouter.navigate).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
  });

  it('puts the row organization id in the URL when its Edit button is clicked', () => {
    renderTab();

    fireEvent.click(screen.getByTestId(`admin-table-row-${ORG_B}`));

    expect(fakeAdminRouter.search).toMatchObject({ tab: 'organizations', orgId: ORG_B });
  });

  it("offers View subscription only on a granted org and opens the grant's subscription record", () => {
    const GRANT_ID = 'c'.repeat(24);
    useAdminOrgGrantsMock.mockReturnValue({ data: [{ id: GRANT_ID, ownerId: ORG_A }] });
    // The fake router models only the /admin search; the detail route is a path change.
    fakeAdminRouter.navigate.mockImplementationOnce(() => undefined);
    renderTab();

    fireEvent.click(screen.getByTestId(`org-actions-${ORG_B}`));
    expect(screen.queryByTestId(`view-subscription-${ORG_B}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`org-actions-${ORG_A}`));
    fireEvent.click(screen.getByTestId(`view-subscription-${ORG_A}`));

    expect(fakeAdminRouter.navigate).toHaveBeenCalledWith({
      to: '/admin/subscriptions/$subscriptionId',
      params: { subscriptionId: GRANT_ID },
    });
  });

  it('offers Sync from Stripe on a paid org and opens the subscriptions list narrowed to its customer', () => {
    const GRANT_ID = 'c'.repeat(24);
    useAdminOrgGrantsMock.mockReturnValue({ data: [{ id: GRANT_ID, ownerId: ORG_B }] });
    mockList({
      data: {
        data: [
          { ...organization(ORG_A, 'Alpha Org'), stripeCustomerId: 'cus_alpha' },
          organization(ORG_B, 'Beta Org'),
          { ...organization('d'.repeat(24), 'Solo Org'), personal: true },
        ],
        totalOrganizations: 3,
        totalPages: 1,
      },
    });
    renderTab();

    fireEvent.click(screen.getByTestId(`org-actions-${ORG_B}`));
    expect(screen.queryByTestId(`sync-from-stripe-${ORG_B}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`org-actions-${'d'.repeat(24)}`));
    expect(screen.queryByTestId(`sync-from-stripe-${'d'.repeat(24)}`)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`org-actions-${ORG_A}`));
    fireEvent.click(screen.getByTestId(`sync-from-stripe-${ORG_A}`));

    expect(useSubscriptionsTab.getState().params).toMatchObject({ ...CLEARED_FILTER_PARAMS, search: 'cus_alpha' });
    expect(fakeAdminRouter.search).toMatchObject({ tab: ADMIN_SUBSCRIPTIONS_TAB_SLUG });
  });

  it('shows skeletons while loading, then an actionable empty state', () => {
    mockList({ data: undefined, isLoading: true, isFetching: true });
    const { rerender } = renderTab();
    expect(screen.getAllByTestId('admin-table-skeleton-row')).toHaveLength(8);

    mockList({ data: { data: [], totalOrganizations: 0, totalPages: 0 } });
    rerender(
      <CssVarsProvider theme={appTheme}>
        <UndoToastProvider>
          <OrganizationsTab />
        </UndoToastProvider>
      </CssVarsProvider>
    );
    expect(screen.getByText('No organizations yet')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-empty-action-btn'));
    expect(screen.getByTestId('org-create-dialog')).toBeInTheDocument();
  });

  it('shows a retry action instead of stale rows after an error', () => {
    const refetch = vi.fn();
    mockList({ isError: true, refetch });
    renderTab();
    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Organizations could not be loaded.');
    expect(screen.queryByText('Alpha Org')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('clears a type filter when no organizations match', () => {
    mockList({ data: { data: [], totalOrganizations: 0, totalPages: 0 } });
    renderTab();
    fireEvent.click(screen.getByTestId('admin-filter-org-type'));
    fireEvent.click(screen.getByTestId('admin-filter-org-type-true'));
    expect(screen.getByText('No organizations match these filters')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-empty-action-btn'));
    expect(useOrganizationsTab.getState().params.personal).toBeUndefined();
  });

  it('keeps server sort and direction choices available', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('admin-filter-org-sort'));
    fireEvent.click(screen.getByTestId('admin-filter-org-sort-createdAt'));
    fireEvent.click(screen.getByTestId('admin-filter-org-direction'));
    fireEvent.click(screen.getByTestId('admin-filter-org-direction-desc'));

    expect(useOrganizationsTab.getState().params).toMatchObject({ sortBy: 'createdAt', sortDirection: 'desc' });
    expect(fakeAdminRouter.search).toMatchObject({ orgsSort: 'createdAt', orgsOrder: 'desc' });
  });

  it('keeps the shared table page size in the URL', () => {
    renderTab();
    fireEvent.mouseDown(screen.getByTestId('admin-table-page-size'));
    fireEvent.click(screen.getByTestId('admin-table-page-size-50'));

    expect(useOrganizationsTab.getState().params.limit).toBe(50);
    expect(fakeAdminRouter.search).toMatchObject({ orgsLimit: 50, orgsPage: 1 });
  });

  it.each([
    ['topup', 'topup-credits', 'org-topup-dialog', 'org-topup-reason-input', 'topup-submit'],
    ['revoke', 'revoke-grant', 'org-revoke-dialog', 'revoke-reason-input', 'revoke-submit'],
    [
      'convert',
      'convert-to-paid',
      'org-convert-to-paid-dialog',
      'org-convert-to-paid-dialog-reason-input',
      'org-convert-to-paid-dialog-confirm-btn',
    ],
  ] as const)(
    'keeps a failed %s action open with its reason and retries',
    async (kind, action, dialog, reason, confirm) => {
      useAdminOrgGrantsMock.mockReturnValue({ data: [{ id: 'c'.repeat(24), ownerId: ORG_A }] });
      actions[kind].mockRejectedValueOnce(new Error('Request failed')).mockResolvedValue({});
      renderTab();
      fireEvent.click(screen.getByTestId(`org-actions-${ORG_A}`));
      fireEvent.click(screen.getByTestId(`${action}-${ORG_A}`));
      fireEvent.click(screen.getByTestId(`${reason}-preset-0`));
      fireEvent.click(screen.getByTestId(confirm));
      await waitFor(() => expect(actions[kind]).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId(dialog)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId(confirm)).not.toBeDisabled());
      fireEvent.click(screen.getByTestId(confirm));
      await waitFor(() => expect(actions[kind]).toHaveBeenCalledTimes(2));
      expect(actions[kind].mock.calls[1]).toEqual(actions[kind].mock.calls[0]);
    }
  );

  it.each([false, true])('opens a paid checkout with clipboard failure=%s', async clipboardFails => {
    const writeText = clipboardFails
      ? vi.fn().mockRejectedValue(new Error('Clipboard denied'))
      : vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    actions.convert.mockResolvedValue({ checkoutUrl: 'https://checkout.example.com/session' });
    useAdminOrgGrantsMock.mockReturnValue({ data: [{ id: 'c'.repeat(24), ownerId: ORG_A }] });
    renderTab();
    fireEvent.click(screen.getByTestId(`org-actions-${ORG_A}`));
    fireEvent.click(screen.getByTestId(`convert-to-paid-${ORG_A}`));
    fireEvent.click(screen.getByTestId('org-convert-to-paid-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('org-convert-to-paid-dialog-confirm-btn'));
    await waitFor(() => expect(openInNewTab).toHaveBeenCalledWith('https://checkout.example.com/session'));
    expect(writeText).toHaveBeenCalledWith('https://checkout.example.com/session');
    if (clipboardFails) {
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.info).toHaveBeenCalledWith('Checkout link created. Copy the URL from the checkout tab.');
    } else {
      expect(toast.success).toHaveBeenCalledWith('Checkout URL copied to clipboard');
    }
    expect(actions.convert).toHaveBeenCalledWith({
      organizationId: ORG_A,
      callbackUrl: window.location.href,
      reason: 'Trial converting to paid',
    });
  });

  it('debounces requests and cancels a pending search when cleared', async () => {
    renderTab();
    const input = screen.getByTestId('admin-organizations-search-input');
    fireEvent.change(input, { target: { value: 'Alpha' } });
    expect(input).toHaveValue('Alpha');
    expect(useSearchOrganizationsMock.mock.calls.at(-1)?.[0].search).toBe('');
    await waitFor(() => expect(useSearchOrganizationsMock.mock.calls.at(-1)?.[0].search).toBe('Alpha'));
    fireEvent.change(input, { target: { value: 'Beta' } });
    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(useSearchOrganizationsMock.mock.calls.at(-1)?.[0].search).toBe(''));
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(useSearchOrganizationsMock.mock.calls.at(-1)?.[0].search).toBe('');
  });

  it('validates a grant reason and retains the form after a failed grant', async () => {
    actions.grant.mockRejectedValueOnce(new Error('Grant failed')).mockResolvedValue({});
    renderTab();
    fireEvent.click(screen.getByTestId('admin-organizations-create-btn'));
    fireEvent.click(screen.getByTestId('grant-org-toggle').querySelector('input')!);
    fireEvent.change(screen.getByTestId('org-name-input').querySelector('input')!, {
      target: { value: '  Trial team  ' },
    });
    fireEvent.change(screen.getByTestId('grant-owner-email-input').querySelector('input')!, {
      target: { value: ' owner@example.com ' },
    });
    expect(screen.getByTestId('grant-org-submit')).toBeDisabled();
    fireEvent.click(screen.getByTestId('org-grant-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('grant-org-submit'));
    await waitFor(() =>
      expect(actions.grant).toHaveBeenCalledWith({
        name: 'Trial team',
        ownerEmail: 'owner@example.com',
        seats: 4,
        initialCredits: 200000,
        reason: 'Pilot or partner access',
      })
    );
    expect(screen.getByTestId('org-create-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('grant-org-submit'));
    await waitFor(() => expect(actions.grant).toHaveBeenCalledTimes(2));
  });

  it('keeps the seat dialog and entered count after a failed adjustment', async () => {
    const mutateAsync = vi.fn().mockRejectedValue(new Error('Seat save failed'));
    useAdjustOrgSeatsMock.mockReturnValue({ mutateAsync, isPending: false });
    useAdminOrgGrantsMock.mockReturnValue({ data: [{ id: 'c'.repeat(24), ownerId: ORG_A }] });
    renderTab();
    fireEvent.click(screen.getByTestId(`org-actions-${ORG_A}`));
    fireEvent.click(screen.getByTestId(`adjust-seats-${ORG_A}`));
    fireEvent.change(screen.getByTestId('seats-native-input'), { target: { value: '6' } });
    fireEvent.click(screen.getByTestId('seats-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('seats-submit'));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ organizationId: ORG_A, seats: 6, reason: 'Customer request' })
    );
    expect(screen.getByTestId('org-seats-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('seats-native-input')).toHaveValue(6);
    expect(screen.queryByTestId('undo-toast')).toBeNull();
  });

  it.each(['create', 'grant'] as const)('blocks another %s while its request is pending', async kind => {
    let completeRequest: (result: unknown) => void = () => {
      throw new Error('Request not started');
    };
    actions[kind].mockImplementation(
      () =>
        new Promise(resolve => {
          completeRequest = resolve;
        })
    );
    renderTab();
    fireEvent.click(screen.getByTestId('admin-organizations-create-btn'));
    fireEvent.change(screen.getByTestId('org-name-input').querySelector('input')!, { target: { value: 'New team' } });
    if (kind === 'grant') {
      fireEvent.click(screen.getByTestId('grant-org-toggle').querySelector('input')!);
      fireEvent.change(screen.getByTestId('grant-owner-email-input').querySelector('input')!, {
        target: { value: 'owner@example.com' },
      });
      fireEvent.click(screen.getByTestId('org-grant-reason-input-preset-0'));
    }
    const submit = screen.getByTestId(kind === 'grant' ? 'grant-org-submit' : 'create-org-submit');
    fireEvent.click(submit);
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(actions[kind]).toHaveBeenCalledTimes(1);
    await act(async () => completeRequest({}));
    await waitFor(() => expect(screen.queryByTestId('org-create-dialog')).not.toBeInTheDocument());
  });

  it('retains a failed create name and retries it', async () => {
    actions.create.mockRejectedValueOnce(new Error('Create failed')).mockResolvedValue({});
    renderTab();
    fireEvent.click(screen.getByTestId('admin-organizations-create-btn'));
    fireEvent.change(screen.getByTestId('org-name-input').querySelector('input')!, { target: { value: 'New team' } });
    fireEvent.click(screen.getByTestId('create-org-submit'));
    await waitFor(() => expect(actions.create).toHaveBeenCalledWith('New team'));
    expect(screen.getByTestId('org-create-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('create-org-submit'));
    await waitFor(() => expect(actions.create).toHaveBeenCalledTimes(2));
  });

  it('changes granted seats with a reason and offers an audited undo', async () => {
    useAdminOrgGrantsMock.mockReturnValue({ data: [{ id: 'c'.repeat(24), ownerId: ORG_A }] });
    const mutateAsync = vi.fn().mockResolvedValue({ seats: 6 });
    useAdjustOrgSeatsMock.mockReturnValue({ mutateAsync, isPending: false });
    renderTab();
    fireEvent.click(screen.getByTestId(`org-actions-${ORG_A}`));
    fireEvent.click(screen.getByTestId(`adjust-seats-${ORG_A}`));
    fireEvent.change(screen.getByTestId('seats-native-input'), { target: { value: '6' } });
    expect(screen.getByTestId('org-seats-preview-after')).toHaveTextContent('6');
    fireEvent.click(screen.getByTestId('seats-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('seats-submit'));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ organizationId: ORG_A, seats: 6, reason: 'Customer request' })
    );
    fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenLastCalledWith({
        organizationId: ORG_A,
        seats: 4,
        reason: 'Undo: Customer request',
      })
    );
  });
});
