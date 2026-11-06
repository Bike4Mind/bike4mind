import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { AdminSubscriptionRow } from '@client/app/utils/adminSubscriptionsFilter';
import { getThemeConfig } from '@client/app/utils/themes';
import { subscriptionsColumns } from './subscriptionsColumns';

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;

const NOW = new Date('2026-10-15T00:00:00.000Z');

const row: AdminSubscriptionRow = {
  id: 's1',
  subscriptionId: 'sub_1',
  ownerType: 'User',
  ownerId: 'u1',
  owner: null,
  ownerAlert: null,
  plan: { priceId: 'price_pro', name: 'Professional', interval: 'monthly' },
  billedInterval: { interval: 'month', intervalCount: 1 },
  status: 'active',
  source: 'stripe',
  quantity: 1,
  customCreditsPerCycle: null,
  mrr: null,
  periodStartsAt: '2026-10-01T00:00:00.000Z',
  periodEndsAt: '2026-11-01T00:00:00.000Z',
  canceledAt: null,
  cancelAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
};

const renderCell = (columnId: 'renews' | 'started' | 'status', overrides: Partial<AdminSubscriptionRow>) => {
  const column = subscriptionsColumns({ now: NOW, newSince: null }).find(c => c.id === columnId);
  if (!column) throw new Error(`no ${columnId} column`);
  return render(<>{column.render({ ...row, ...overrides })}</>, { wrapper: Wrapper });
};

describe('subscriptionsColumns date fallbacks', () => {
  it('shows a dash in Renews when periodEndsAt is null, and a date otherwise', () => {
    const { unmount } = renderCell('renews', { periodEndsAt: null });
    expect(screen.getByLabelText('None')).toBeTruthy();
    unmount();

    renderCell('renews', {});
    expect(screen.queryByLabelText('None')).toBeNull();
    expect(screen.getByText('in 17d')).toBeTruthy();
  });

  it('shows a dash in Started when createdAt is null, and a date otherwise', () => {
    const { unmount } = renderCell('started', { createdAt: null });
    expect(screen.getByLabelText('None')).toBeTruthy();
    unmount();

    renderCell('started', {});
    expect(screen.queryByLabelText('None')).toBeNull();
    expect(screen.getByText('14d ago')).toBeTruthy();
  });
});

describe('subscriptionsColumns owner alert', () => {
  it('flags a live subscription that still bills a deleted or blocked owner', () => {
    const { unmount } = renderCell('status', { ownerAlert: 'owner_deleted' });
    expect(screen.getByTestId('admin-subscriptions-owner-alert-s1').textContent).toBe('Owner deleted');
    unmount();

    renderCell('status', { ownerAlert: 'owner_blocked' });
    expect(screen.getByTestId('admin-subscriptions-owner-alert-s1').textContent).toBe('Owner blocked');
  });

  it('shows no flag for a healthy owner', () => {
    renderCell('status', {});
    expect(screen.queryByTestId('admin-subscriptions-owner-alert-s1')).toBeNull();
  });
});
