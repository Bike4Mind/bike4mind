// @vitest-environment jsdom
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
  useRateLimitMetrics: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.search,
}));

vi.mock('./hooks/useRateLimitMetrics', () => ({
  useRateLimitMetrics: (...args: unknown[]) => {
    mocks.useRateLimitMetrics(...args);
    return { data: [], isLoading: false, forceRefresh: vi.fn() };
  },
}));

import RateLimitsTab from './index';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <RateLimitsTab />
    </CssVarsProvider>
  );

type SearchUpdater = (previous: Record<string, unknown>) => Record<string, unknown>;
const lastSearchUpdate = (previous: Record<string, unknown>) =>
  (mocks.navigate.mock.calls.at(-1)?.[0] as { search: SearchUpdater }).search(previous);

const throttledCheckbox = () => screen.getByRole('checkbox', { name: 'Throttled only' }) as HTMLInputElement;

describe('RateLimitsTab URL state', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.useRateLimitMetrics.mockReset();
    mocks.search = {};
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
