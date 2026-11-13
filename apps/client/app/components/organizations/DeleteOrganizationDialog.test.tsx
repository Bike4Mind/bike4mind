import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, WithId } from '@bike4mind/common';
import DeleteOrganizationDialog, {
  blockingSubscriptions,
  unblockedBilledSubscriptions,
} from './DeleteOrganizationDialog';

const deleteOrg = vi.hoisted(() => vi.fn());
const subs = vi.hoisted(() => ({ value: { data: [] as unknown[], isPending: false, isError: false } }));
const pendingSeats = vi.hoisted(() => ({ value: 0 }));
const fetchOrganizationGroups = vi.hoisted(() => vi.fn());

vi.mock('@client/app/hooks/data/organizations', () => ({
  useDeleteOrganization: () => ({ mutateAsync: deleteOrg, isPending: false }),
  useOrganizationSeats: () => ({ pendingSeats: pendingSeats.value }),
}));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetOrganizationUsers: () => ({
    data: [
      { id: 'owner1', name: 'Olivia' },
      { id: 'u1', name: 'Alice' },
      { id: 'u2', name: 'Bob' },
    ],
  }),
}));
vi.mock('@client/app/hooks/data/subscriptions', () => ({
  useGetSubscriptionsByOwner: () => subs.value,
}));
vi.mock('@client/app/utils/groupsAPICalls', () => ({
  fetchOrganizationGroups: (...args: unknown[]) => fetchOrganizationGroups(...args),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const org = {
  id: 'org1',
  name: 'Acme Labs',
  userId: 'owner1',
  personal: false,
  currentCredits: 12500,
  allowedGroupTypes: ['sales'],
  users: [],
} as unknown as WithId<IOrganizationDocument>;

const activeStripePlan = {
  status: 'active',
  source: 'stripe',
  subscriptionId: 'sub_1',
  canceledAt: null,
  periodEndsAt: '2026-12-01T00:00:00.000Z',
};

const renderDialog = (overrides: { canOpenBilling?: boolean } = {}) => {
  const onDeleted = vi.fn();
  const onOpenBilling = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { unmount } = render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <DeleteOrganizationDialog
          open
          organization={org}
          canOpenBilling={overrides.canOpenBilling ?? true}
          onClose={vi.fn()}
          onOpenBilling={onOpenBilling}
          onDeleted={onDeleted}
        />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return { onDeleted, onOpenBilling, unmount };
};

const confirmButton = () => screen.getByTestId('delete-organization-confirm-btn') as HTMLButtonElement;
const typeName = (value: string) =>
  fireEvent.change(screen.getByTestId('delete-organization-name-input'), { target: { value } });

describe('DeleteOrganizationDialog', () => {
  beforeEach(() => {
    deleteOrg.mockReset().mockResolvedValue('org1');
    subs.value = { data: [], isPending: false, isError: false };
    pendingSeats.value = 0;
    fetchOrganizationGroups.mockReset().mockResolvedValue([{ id: 'g1' }, { id: 'g2' }]);
  });

  it('summarizes what the delete removes', async () => {
    pendingSeats.value = 1;
    renderDialog();

    expect(screen.getByTestId('delete-organization-impact-members').textContent).toContain('Removes 2 members');
    expect(screen.getByTestId('delete-organization-impact-invites').textContent).toContain('1 pending invite');
    expect(screen.getByTestId('delete-organization-impact-credits').textContent).toContain('12,500 remaining credits');
    expect((await screen.findByTestId('delete-organization-impact-groups')).textContent).toContain('2 groups');
    expect(screen.getByTestId('delete-organization-plan-none')).toBeTruthy();
  });

  it('enables Delete only once the exact team name is typed', () => {
    renderDialog();
    expect(confirmButton().disabled).toBe(true);
    typeName('acme labs');
    expect(confirmButton().disabled).toBe(true);
    typeName('Acme Labs');
    expect(confirmButton().disabled).toBe(false);
  });

  it('deletes and reports the end state', async () => {
    const { onDeleted } = renderDialog();
    typeName('Acme Labs');
    fireEvent.click(confirmButton());

    await waitFor(() => expect(deleteOrg).toHaveBeenCalledWith('org1'));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });

  it('stays open with the reason when the delete fails', async () => {
    deleteOrg.mockRejectedValueOnce(new Error('Organization has active subscriptions'));
    const { onDeleted } = renderDialog();
    typeName('Acme Labs');
    fireEvent.click(confirmButton());

    expect((await screen.findByTestId('delete-organization-error')).textContent).toContain(
      'Organization has active subscriptions'
    );
    expect(onDeleted).not.toHaveBeenCalled();
    expect(confirmButton().disabled).toBe(false);
  });

  it('blocks the delete while a plan is active and points to Billing', () => {
    subs.value = { data: [activeStripePlan], isPending: false, isError: false };
    const { onOpenBilling } = renderDialog();
    typeName('Acme Labs');

    expect(confirmButton().disabled).toBe(true);
    expect(screen.getByTestId('delete-organization-plan-blocking').textContent).toContain(
      'Cancel it from Billing first'
    );
    fireEvent.click(screen.getByTestId('delete-organization-open-billing-btn'));
    expect(onOpenBilling).toHaveBeenCalled();
  });

  it('explains that a plan canceled at period end still blocks until it ends', () => {
    subs.value = {
      data: [{ ...activeStripePlan, canceledAt: '2026-11-10T00:00:00.000Z' }],
      isPending: false,
      isError: false,
    };
    renderDialog();

    expect(screen.getByTestId('delete-organization-plan-blocking').textContent).toContain(
      'stays active until December 1, 2026'
    );
    expect(screen.queryByTestId('delete-organization-open-billing-btn')).toBeNull();
  });

  it('explains every blocking plan, and offers Billing only for one it can cancel', () => {
    subs.value = {
      data: [{ status: 'active', source: 'admin_grant', canceledAt: null, periodEndsAt: '2026-12-01T00:00:00.000Z' }],
      isPending: false,
      isError: false,
    };
    const { unmount } = renderDialog();
    expect(screen.getByTestId('delete-organization-plan-blocking').textContent).toContain('Contact support');
    expect(screen.queryByTestId('delete-organization-open-billing-btn')).toBeNull();
    unmount();

    subs.value = {
      data: [subs.value.data[0], activeStripePlan],
      isPending: false,
      isError: false,
    };
    renderDialog();
    const text = screen.getByTestId('delete-organization-plan-blocking').textContent;
    expect(text).toContain('Contact support');
    expect(text).toContain('Cancel it from Billing first');
    expect(screen.getByTestId('delete-organization-open-billing-btn')).toBeTruthy();
  });

  it('offers no Billing button to a viewer the Billing tab refuses', () => {
    subs.value = { data: [activeStripePlan], isPending: false, isError: false };
    renderDialog({ canOpenBilling: false });
    expect(screen.queryByTestId('delete-organization-open-billing-btn')).toBeNull();
  });

  it('warns that a delinquent plan keeps billing after the delete, without blocking it', () => {
    subs.value = { data: [{ ...activeStripePlan, status: 'past_due' }], isPending: false, isError: false };
    renderDialog();
    typeName('Acme Labs');

    expect(screen.getByTestId('delete-organization-plan-billed')).toBeTruthy();
    expect(confirmButton().disabled).toBe(false);
  });

  it('waits for the plan check before allowing the delete', () => {
    subs.value = { data: [], isPending: true, isError: false };
    renderDialog();
    typeName('Acme Labs');
    expect(confirmButton().disabled).toBe(true);
  });
});

describe('subscription predicates', () => {
  it('blocks on exactly the rows the delete route refuses (status active)', () => {
    const rows = [
      { status: 'active' },
      { status: 'past_due' },
      { status: 'trialing' },
      { status: 'canceled' },
    ] as const;
    expect(blockingSubscriptions(rows).map(row => row.status)).toEqual(['active']);
  });

  it('warns only about non-blocking rows Stripe still bills', () => {
    const rows = [
      { status: 'active', source: 'stripe', subscriptionId: 'a' },
      { status: 'past_due', source: 'stripe', subscriptionId: 'b' },
      { status: 'canceled', source: 'stripe', subscriptionId: 'c' },
      { status: 'past_due', source: 'admin_grant' },
    ] as const;
    expect(
      unblockedBilledSubscriptions(rows as never).map((row: { subscriptionId?: string }) => row.subscriptionId)
    ).toEqual(['b']);
  });
});
