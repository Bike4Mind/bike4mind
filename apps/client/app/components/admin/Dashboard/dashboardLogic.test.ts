import { describe, expect, it } from 'vitest';
import type { SpendData } from '@bike4mind/common';
import type { AnalyticsOverview } from '@client/app/utils/analyticsOverview';
import type { AdminRevenueTrendResponse } from '@bike4mind/server-utils/app/utils/adminRevenue';
import { AdminTab } from '../adminSidebarConfig';
import { adminTabToSlug } from '../adminTabSlugs';
import { EMPTY_PAGE_USAGE, MAX_PINNED_PAGES, mostVisitedSlugs, withPinToggled, withVisit } from './adminPageVisits';
import { ACTION_COUNT_TABS, pinnedSidebarSection } from './dashboardNav';
import { spendWindow } from './dashboardRange';
import { splitActionCounts } from './NeedsAttentionStrip';
import { costPerActiveUser } from './PulseSection';
import { revenueMovement } from './HealthAndRevenue';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 26, 12);

describe('admin page visits', () => {
  it('ranks recent visits above old ones with more raw visits', () => {
    let usage = EMPTY_PAGE_USAGE;
    for (let i = 0; i < 3; i += 1) usage = withVisit(usage, 'users', NOW - 60 * DAY);
    usage = withVisit(usage, 'spend-explorer', NOW - DAY);
    usage = withVisit(usage, 'spend-explorer', NOW);
    expect(mostVisitedSlugs(usage, NOW, 5)).toEqual(['spend-explorer', 'users']);
  });

  it('keeps pinned pages out of the most-visited list', () => {
    const usage = withPinToggled(withVisit(withVisit(EMPTY_PAGE_USAGE, 'users', NOW), 'feedback', NOW), 'users');
    expect(usage.pins).toEqual(['users']);
    expect(mostVisitedSlugs(usage, NOW, 5)).toEqual(['feedback']);
  });

  it('toggles a pin off and refuses one past the cap', () => {
    const full = Array.from({ length: MAX_PINNED_PAGES }, (_, i) => `tab-${i}`).reduce(
      (usage, slug) => withPinToggled(usage, slug),
      EMPTY_PAGE_USAGE
    );
    expect(withPinToggled(full, 'one-more')).toBe(full);
    expect(withPinToggled(full, 'tab-0').pins).not.toContain('tab-0');
  });

  it('frees the slots of pins the viewer can no longer see', () => {
    const full = Array.from({ length: MAX_PINNED_PAGES }, (_, i) => `tab-${i}`).reduce(
      (usage, slug) => withPinToggled(usage, slug),
      EMPTY_PAGE_USAGE
    );
    const pins = withPinToggled(full, 'one-more', slug => slug !== 'tab-3').pins;
    expect(pins).not.toContain('tab-3');
    expect(pins).toContain('one-more');
  });
});

describe('dashboard navigation', () => {
  it('maps each badged queue to the tab whose sidebar item shows that badge', () => {
    expect(ACTION_COUNT_TABS.get('feedback')).toBe(AdminTab.Feedback);
    expect(ACTION_COUNT_TABS.get('signupRiskReview')).toBe(AdminTab.SignupRiskReview);
  });

  it('builds the Pinned group from openable pins only, with collision-free testids', () => {
    const feedback = adminTabToSlug(AdminTab.Feedback) as string;
    const revenue = adminTabToSlug(AdminTab.Revenue) as string;
    const section = pinnedSidebarSection([feedback, 'no-such-tab', revenue], tab => tab !== AdminTab.Revenue);
    expect(section?.items.map(item => item.tab)).toEqual([AdminTab.Feedback]);
    expect(section?.items[0].testid).toBe(`admin-sidebar-pinned-${feedback}`);
    expect(pinnedSidebarSection([], () => true)).toBeNull();
  });
});

describe('splitActionCounts', () => {
  it('orders waiting queues by size and separates clear and failed counts', () => {
    const { waiting, clear, failed } = splitActionCounts({
      feedback: 3,
      signupRiskReview: 12,
      approvals: 0,
      sreAgent: null,
    });
    expect(waiting.map(item => [item.id, item.count])).toEqual([
      ['signupRiskReview', '12'],
      ['feedback', '3'],
    ]);
    expect(clear).toEqual(['approvals']);
    expect(failed).toEqual(['sreAgent']);
  });
});

describe('spendWindow', () => {
  it('ends on the hour and spans the range', () => {
    const { dateFrom, dateTo } = spendWindow('7d', NOW + 25 * 60 * 1000);
    expect(dateTo).toBe(new Date(NOW).toISOString());
    expect(Date.parse(dateTo) - Date.parse(dateFrom)).toBe(7 * DAY);
  });
});

describe('costPerActiveUser', () => {
  const spend = {
    kpis: [{ key: 'estCost', label: 'Cost', value: 300, priorValue: 200, format: 'currency', higherIsBetter: false }],
  } as unknown as SpendData;
  const overview = {
    stats: { mau: { value: 1000, previous: 800 } },
    activeUsers: {
      days: [
        { day: '2026-11-24', wau: 500, partial: false },
        { day: '2026-11-25', wau: 600, partial: false },
        { day: '2026-11-26', wau: 700, partial: true },
      ],
    },
  } as unknown as AnalyticsOverview;

  it('divides by MAU for 28 days, with a previous-period value', () => {
    expect(costPerActiveUser(spend, overview, '28d')).toEqual({ value: 0.3, previous: 0.25 });
  });

  it('divides by WAU on the last complete day for 7 days, without a comparison', () => {
    expect(costPerActiveUser(spend, overview, '7d')).toEqual({ value: 0.5, previous: null });
  });
});

describe('revenueMovement', () => {
  const point = (newMrr: number, churnedMrr: number, payingCount: number) => ({
    date: '2026-11-01',
    mrr: 0,
    payingCount,
    newMrr,
    churnedMrr,
    pastDueMrr: 500,
    cancelingMrr: 0,
    payingUsers: 0,
    payingOrgs: 0,
    mrrByPlan: {},
  });

  it('sums the per-day movement over the last N snapshots', () => {
    const revenue: AdminRevenueTrendResponse = {
      stripeConfigured: true,
      trend: [point(999, 999, 1), point(100, 10, 40), point(200, 0, 42)],
    };
    expect(revenueMovement(revenue, 2)).toEqual({
      newMrr: 300,
      churnedMrr: 10,
      pastDueMrr: 500,
      payingCount: 42,
      payingChange: 41,
    });
  });

  it('is null without Stripe', () => {
    expect(revenueMovement({ stripeConfigured: false }, 7)).toBeNull();
  });
});
