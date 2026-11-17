// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), search: {} as Record<string, unknown> }));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.search,
}));

import { useRateLimitsSearchParams } from './useRateLimitsSearchParams';

type SearchUpdater = (previous: Record<string, unknown>) => Record<string, unknown>;

const lastSearchUpdate = (previous: Record<string, unknown>) => {
  const call = mocks.navigate.mock.calls.at(-1)?.[0] as { search: SearchUpdater; replace: boolean; to: string };
  expect(call.to).toBe('/admin');
  expect(call.replace).toBe(true);
  return call.search(previous);
};

describe('useRateLimitsSearchParams', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.search = {};
  });

  it('reads the applied state from the URL', () => {
    mocks.search = { rateIntegration: 'slack', rateThrottled: 'true', rateView: 'raw' };
    const { result } = renderHook(() => useRateLimitsSearchParams());
    expect(result.current).toMatchObject({ integration: 'slack', throttledOnly: true, view: 'raw' });
  });

  it('falls back to the defaults for an invalid param', () => {
    mocks.search = { rateIntegration: 'bogus', rateView: 'chart', rateFrom: 'soon' };
    const { result } = renderHook(() => useRateLimitsSearchParams());
    expect(result.current).toMatchObject({ integration: '', view: 'overview', dateFrom: '' });
  });

  it('writes a patch with replace, keeping unrelated params', () => {
    const { result } = renderHook(() => useRateLimitsSearchParams());
    act(() => result.current.patch({ view: 'raw' }));
    expect(lastSearchUpdate({ tab: 'rate-limits', rateIntegration: 'jira' })).toEqual({
      tab: 'rate-limits',
      rateIntegration: 'jira',
      rateFrom: undefined,
      rateTo: undefined,
      rateThrottled: undefined,
      rateView: 'raw',
    });
  });

  it('removes params set back to their defaults', () => {
    const { result } = renderHook(() => useRateLimitsSearchParams());
    act(() => result.current.patch({ integration: '', throttledOnly: false, view: 'overview' }));
    const next = lastSearchUpdate({ rateIntegration: 'github', rateThrottled: 'true', rateView: 'raw' });
    expect(next).toMatchObject({ rateIntegration: undefined, rateThrottled: undefined, rateView: undefined });
  });
});
