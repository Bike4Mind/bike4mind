import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { SpendFeatureRow, SpendFeaturesResponse, SpendFeatureUsersResponse } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ useSpendFeatures: vi.fn(), useSpendFeatureUsers: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, 'data-testid': testId }: { children: ReactNode; 'data-testid'?: string }) => (
    <a data-testid={testId}>{children}</a>
  ),
}));
vi.mock('./useFeatureCost', () => ({
  useSpendFeatures: (...args: unknown[]) => h.useSpendFeatures(...args),
  useSpendFeatureUsers: (...args: unknown[]) => h.useSpendFeatureUsers(...args),
}));

import {
  FeatureCostSection,
  foldDailySeries,
  UserFeaturesPanel,
  type FeatureCostSelection,
} from './FeatureCostSection';

const theme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

const RANGE = { from: new Date('2026-03-08T00:00:00Z'), to: new Date('2026-03-11T00:00:00Z') };
const USER_ID = 'a'.repeat(24);

const row = (overrides: Partial<SpendFeatureRow>): SpendFeatureRow => ({
  feature: 'chat',
  requests: 10,
  failedRequests: 0,
  costUsd: 0,
  creditsCharged: 0,
  units: 0,
  distinctUsers: 1,
  lastDayUsd: 0,
  share: 0,
  unitLabel: null,
  trailingAvgUsd: 0,
  isSpike: false,
  dailyUsd: [0, 0, 0],
  ...overrides,
});

const FEATURES: SpendFeaturesResponse = {
  audience: 'all',
  totalCostUsd: 80,
  spikeMultiple: 3,
  lastDayStart: '2026-03-10T00:00:00.000Z',
  days: ['2026-03-08', '2026-03-09', '2026-03-10'],
  features: [
    row({
      feature: 'music_generation',
      costUsd: 60,
      share: 0.75,
      units: 1200,
      unitLabel: 'seconds',
      failedRequests: 2,
      isSpike: true,
      lastDayUsd: 50,
      trailingAvgUsd: 1,
    }),
    row({ feature: 'chat', costUsd: 20, share: 0.25, distinctUsers: 4 }),
  ],
};

const USERS: SpendFeatureUsersResponse = {
  feature: 'music_generation',
  audience: 'all',
  unitLabel: 'seconds',
  featureCostUsd: 60,
  totalUsers: 31,
  spikeMultiple: 3,
  users: [
    {
      userId: USER_ID,
      name: 'Heavy User',
      requests: 5,
      failedRequests: 1,
      costUsd: 45,
      creditsCharged: 900,
      units: 600,
      lastDayUsd: 40,
      trailingAvgUsd: 0,
      share: 0.75,
      isSpike: true,
    },
  ],
};

const ok = <T,>(data: T) => ({
  data,
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
});

function renderSection(selection: Partial<FeatureCostSelection> = {}) {
  const onChange = vi.fn();
  render(
    <FeatureCostSection
      range={RANGE}
      rangeLabel="8 Mar to 10 Mar"
      selection={{ audience: 'all', feature: null, user: null, ...selection }}
      onChange={onChange}
    />,
    { wrapper: TestWrapper }
  );
  return { onChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.useSpendFeatures.mockReturnValue(ok(FEATURES));
  h.useSpendFeatureUsers.mockReturnValue(ok(USERS));
});

describe('FeatureCostSection', () => {
  it('lists features with cost, units, failures and spike flags, and opens a feature on click', () => {
    const { onChange } = renderSection();

    expect(h.useSpendFeatures).toHaveBeenCalledWith({ range: RANGE, audience: 'all', enabled: true });
    const music = screen.getByTestId('spend-features-table-row-music_generation');
    expect(within(music).getByText('Music generation')).toBeTruthy();
    expect(within(music).getByText('1,200 seconds')).toBeTruthy();
    expect(within(music).getByText('75%')).toBeTruthy();
    expect(within(music).getByTestId('spend-features-spike-chip-music_generation')).toBeTruthy();
    expect(screen.queryByTestId('spend-features-spike-chip-chat')).toBeNull();

    fireEvent.click(music);
    expect(onChange).toHaveBeenCalledWith({ feature: 'music_generation' });
  });

  it('switches the audience', () => {
    const { onChange } = renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Internal' }));
    expect(onChange).toHaveBeenCalledWith({ audience: 'internal' });
  });

  it("pages a feature's top users from the server and opens a user on click", () => {
    const { onChange } = renderSection({ feature: 'music_generation', audience: 'external' });

    // The hidden platform table does not query while the drill-down replaces it.
    expect(h.useSpendFeatures).toHaveBeenCalledWith({ range: RANGE, audience: 'external', enabled: false });
    expect(h.useSpendFeatureUsers).toHaveBeenCalledWith({
      range: RANGE,
      audience: 'external',
      feature: 'music_generation',
      page: 1,
      pageSize: 25,
    });
    const userRow = screen.getByTestId(`spend-feature-users-row-${USER_ID}`);
    expect(within(userRow).getByText('Heavy User')).toBeTruthy();
    expect(within(userRow).getByText('600 seconds')).toBeTruthy();
    expect(within(userRow).getByTestId(`spend-feature-users-spike-chip-${USER_ID}`)).toBeTruthy();

    fireEvent.click(userRow);
    expect(onChange).toHaveBeenCalledWith({ user: USER_ID });

    fireEvent.click(screen.getByTestId('spend-feature-users-back-btn'));
    expect(onChange).toHaveBeenCalledWith({ feature: null });
  });

  it('goes back to page 1 when the page size changes', () => {
    renderSection({ feature: 'music_generation' });
    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(h.useSpendFeatureUsers).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, pageSize: 25 }));

    fireEvent.mouseDown(screen.getByTestId('admin-table-page-size'));
    fireEvent.click(screen.getByTestId('admin-table-page-size-50'));
    expect(h.useSpendFeatureUsers).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 50 }));
  });

  it('shows an updating bar while a refetch keeps the old rows on screen', () => {
    h.useSpendFeatures.mockReturnValue({ ...ok(FEATURES), isFetching: true });
    renderSection();
    expect(screen.getByTestId('spend-features-table-updating')).toBeTruthy();
  });

  it("shows one user's whole feature mix with a link to their admin page", () => {
    const { onChange } = renderSection({ feature: 'music_generation', user: USER_ID, audience: 'internal' });

    // A named user's mix ignores the audience filter, so the control is not offered.
    expect(h.useSpendFeatures).toHaveBeenCalledWith({ range: RANGE, audience: 'all', userId: USER_ID });
    expect(screen.queryByTestId('spend-features-audience')).toBeNull();
    expect(screen.getByTestId('spend-user-features-profile-link')).toBeTruthy();
    expect(screen.getByTestId('spend-user-features-table-row-music_generation')).toBeTruthy();

    fireEvent.click(screen.getByTestId('spend-user-features-back-btn'));
    expect(onChange).toHaveBeenCalledWith({ user: null });
  });

  it('names a user picked from the table, but not a different user opened later', () => {
    const { rerender } = render(
      <FeatureCostSection
        range={RANGE}
        rangeLabel="8 Mar to 10 Mar"
        selection={{ audience: 'all', feature: 'music_generation', user: null }}
        onChange={vi.fn()}
      />,
      { wrapper: TestWrapper }
    );
    fireEvent.click(screen.getByTestId(`spend-feature-users-row-${USER_ID}`));
    const openUser = (user: string) =>
      rerender(
        <FeatureCostSection
          range={RANGE}
          rangeLabel="8 Mar to 10 Mar"
          selection={{ audience: 'all', feature: 'music_generation', user }}
          onChange={vi.fn()}
        />
      );
    openUser(USER_ID);
    expect(screen.getByText('Heavy User: features used')).toBeTruthy();
    openUser('b'.repeat(24));
    expect(screen.getByText(`${'b'.repeat(24)}: features used`)).toBeTruthy();
  });

  it('says when a sub-day range is widened to whole UTC days', () => {
    const hour = { from: new Date('2026-03-09T05:00:00Z'), to: new Date('2026-03-09T06:00:00Z') };
    render(<UserFeaturesPanel range={hour} userId={USER_ID} userName="Heavy User" testId="account-spend-features" />, {
      wrapper: TestWrapper,
    });
    expect(screen.getByTestId('account-spend-features-days-note').textContent).toContain('2026-03-09');
    expect(screen.getByTestId('account-spend-features-profile-link')).toBeTruthy();
  });

  it('shows a retryable error when the features fail to load', () => {
    const refetch = vi.fn();
    h.useSpendFeatures.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('boom'),
      refetch,
    });
    renderSection();
    expect(screen.getByText(/Could not load features: boom/)).toBeTruthy();
  });
});

describe('foldDailySeries', () => {
  it('keeps a short series as one bar per day', () => {
    expect(foldDailySeries([1, 2, 3], 31)).toEqual({ bars: [1, 2, 3], daysPerBar: 1 });
  });

  it('folds a long series into multi-day sums that keep the total', () => {
    const days = Array.from({ length: 90 }, (_, i) => i + 1);
    const { bars, daysPerBar } = foldDailySeries(days, 31);
    expect(daysPerBar).toBe(3);
    expect(bars).toHaveLength(30);
    expect(bars[0]).toBe(1 + 2 + 3);
    expect(bars.reduce((sum, bar) => sum + bar, 0)).toBe(days.reduce((sum, day) => sum + day, 0));
  });
});
