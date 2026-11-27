// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
  useRateLimitMetrics: vi.fn(),
  data: [] as unknown[],
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.search,
}));

vi.mock('./hooks/useRateLimitMetrics', () => ({
  useRateLimitMetrics: (...args: unknown[]) => {
    mocks.useRateLimitMetrics(...args);
    return { data: mocks.data, isLoading: false, forceRefresh: vi.fn() };
  },
}));

import RateLimitsTab from './index';

const appTheme = extendTheme({ ...getThemeConfig() });
const tree = () => (
  <CssVarsProvider theme={appTheme}>
    <RateLimitsTab />
  </CssVarsProvider>
);
const renderTab = () => render(tree());

type SearchUpdater = (previous: Record<string, unknown>) => Record<string, unknown>;
const lastSearchUpdate = (previous: Record<string, unknown>) =>
  (mocks.navigate.mock.calls.at(-1)?.[0] as { search: SearchUpdater }).search(previous);

const throttledCheckbox = () => screen.getByRole('checkbox', { name: 'Throttled only' }) as HTMLInputElement;

describe('RateLimitsTab URL state', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.useRateLimitMetrics.mockReset();
    mocks.search = {};
    mocks.data = [];
  });

  it('fetches with the applied filters from the URL and seeds the draft from them', () => {
    mocks.search = { rateIntegration: 'jira', rateThrottled: 'true', rateFrom: '2026-11-10T08:00:00.000Z' };
    renderTab();
    expect(mocks.useRateLimitMetrics).toHaveBeenLastCalledWith({
      dateFrom: '2026-11-10T08:00:00.000Z',
      dateTo: undefined,
      integration: 'jira',
      throttledOnly: true,
    });
    expect(throttledCheckbox().checked).toBe(true);
    expect(screen.getByTestId('rate-limit-integration-select').textContent).toContain('Jira');
    expect((screen.getByLabelText('Date from') as HTMLInputElement).value).toBe('2026-11-10T08:00');
  });

  it('re-syncs the draft when the URL changes while mounted', () => {
    const { rerender } = renderTab();
    expect(throttledCheckbox().checked).toBe(false);
    mocks.search = { rateIntegration: 'jira', rateThrottled: 'true' };
    rerender(tree());
    expect(throttledCheckbox().checked).toBe(true);
    expect(screen.getByTestId('rate-limit-integration-select').textContent).toContain('Jira');
  });

  it('keeps a draft edit local until Apply, then writes it to the URL', () => {
    renderTab();
    fireEvent.click(throttledCheckbox());
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.useRateLimitMetrics).toHaveBeenLastCalledWith(expect.objectContaining({ throttledOnly: undefined }));

    fireEvent.click(screen.getByTestId('rate-limit-apply-btn'));
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate.mock.calls[0][0]).toMatchObject({ to: '/admin', replace: true });
    expect(lastSearchUpdate({ tab: 'rate-limits' })).toMatchObject({ tab: 'rate-limits', rateThrottled: true });
  });

  it('clears the draft and the URL together', () => {
    mocks.search = { rateIntegration: 'slack', rateThrottled: 'true', rateView: 'raw' };
    renderTab();
    fireEvent.click(screen.getByTestId('rate-limit-clear-btn'));
    expect(throttledCheckbox().checked).toBe(false);
    expect(lastSearchUpdate({ ...mocks.search })).toMatchObject({
      rateIntegration: undefined,
      rateThrottled: undefined,
      rateView: 'raw',
    });
  });

  it('opens the sub-tab from the URL and writes a switch back', () => {
    mocks.search = { rateView: 'raw' };
    renderTab();
    expect(screen.getByRole('tab', { name: 'Raw data' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(lastSearchUpdate({ rateView: 'raw' }).rateView).toBeUndefined();
  });
});

const snapshot = (id: string, wasThrottled: boolean) => ({
  _id: id,
  integration: 'slack',
  userId: 'user-1',
  endpoint: `/api/${id}`,
  limit: 100,
  remaining: wasThrottled ? 0 : 40,
  resetAt: null,
  usagePercent: wasThrottled ? 100 : 60,
  wasThrottled,
  retryAfterMs: wasThrottled ? 1500 : null,
  timestamp: '2026-01-01T00:00:00.000Z',
});

describe('RateLimitsTab tables', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.search = {};
    mocks.data = [snapshot('ok', false), snapshot('hit', true)];
  });

  it('lists only throttled snapshots in the overview table', () => {
    renderTab();
    const rows = within(screen.getByTestId('rate-limit-throttled-table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('/api/hit');
    expect(rows[0]).toHaveTextContent('1500ms');
  });

  it('lists every snapshot in the raw table', () => {
    mocks.search = { rateView: 'raw' };
    renderTab();
    const rows = within(screen.getByTestId('rate-limit-raw-table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('60%');
    expect(rows[1]).toHaveTextContent('Yes');
  });

  it('sizes the Timestamp column of both tables for the full locale timestamp', () => {
    const at = new Date(2026, 11, 28, 12, 58, 58);
    mocks.data = [{ ...snapshot('hit', true), timestamp: at.toISOString() }];
    for (const [view, testId] of [
      [undefined, 'rate-limit-throttled-table'],
      ['raw', 'rate-limit-raw-table'],
    ] as const) {
      mocks.search = view ? { rateView: view } : {};
      const { unmount } = renderTab();
      const table = screen.getByTestId(testId);
      const width = within(table).getByRole('columnheader', { name: 'Timestamp' }).style.width;
      expect(width).toMatch(/^[\d.]+rem$/);
      expect(parseFloat(width)).toBeGreaterThanOrEqual(13.5);
      expect(within(table).getByText(at.toLocaleString())).toBeInTheDocument();
      unmount();
    }
  });

  it('offers to clear the filters when they match no snapshot', () => {
    mocks.data = [];
    mocks.search = { rateView: 'raw', rateIntegration: 'slack' };
    renderTab();
    expect(screen.queryByTestId('rate-limit-raw-table')).not.toBeInTheDocument();
    expect(screen.getByText('No rate limit data')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('rate-limit-empty-clear-btn'));
    expect(lastSearchUpdate({ rateIntegration: 'slack', rateView: 'raw' }).rateIntegration).toBeUndefined();
  });
});
