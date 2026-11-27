import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { OverviewTab } from './OverviewTab';
import { buildOrgDetail, buildStripeState, STRIPE_ROW, SubscriptionTestWrapper } from '../subscriptionDetailTestUtils';

const { get, seatChart } = vi.hoisted(() => ({ get: vi.fn(), seatChart: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get } }));
vi.mock('recharts', async importOriginal => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ data }: { data: unknown }) => {
    seatChart(data);
    return <div />;
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Overview history integration', () => {
  it('mounts one real history query and uses its update time for the seats snapshot', async () => {
    const now = Date.UTC(2026, 10, 13, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    get.mockReset().mockResolvedValue({
      data: {
        creditCycles: [
          { start: '2026-11-01T00:00:00Z', end: new Date(now).toISOString(), granted: 1500, used: 100, current: true },
        ],
        creditCyclesTruncated: false,
        creditUsageUnavailable: false,
        seatChanges: [{ at: '2026-11-01T00:00:00Z', quantity: 3 }],
      },
    });
    seatChart.mockReset();
    const detail = buildOrgDetail();
    detail.subscription = { ...detail.subscription, ...STRIPE_ROW };
    detail.seats = { paid: 5, organizationSeats: 5, members: 4, min: 1, max: 50 };
    render(
      <OverviewTab
        detail={detail}
        stripe={buildStripeState()}
        onOpenOwner={vi.fn()}
        onOpenSubscription={vi.fn()}
        onOpenLedger={vi.fn()}
      />,
      { wrapper: SubscriptionTestWrapper }
    );
    await screen.findByTestId('subscription-credit-cycles-chart');
    expect(get).toHaveBeenCalledExactlyOnceWith(`/api/admin/subscriptions/${detail.subscription.id}/history`);
    await waitFor(() =>
      expect(seatChart).toHaveBeenLastCalledWith(
        expect.arrayContaining([expect.objectContaining({ at: now, paid: 5, used: 4 })])
      )
    );
  });
});
