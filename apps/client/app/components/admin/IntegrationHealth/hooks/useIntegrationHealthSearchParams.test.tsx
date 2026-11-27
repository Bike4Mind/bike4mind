// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), search: {} as Record<string, unknown> }));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.search,
}));

import { useIntegrationHealthSearchParams } from './useIntegrationHealthSearchParams';

type SearchUpdater = (previous: Record<string, unknown>) => Record<string, unknown>;

const lastSearchUpdate = (previous: Record<string, unknown>) => {
  const call = mocks.navigate.mock.calls.at(-1)?.[0] as { search: SearchUpdater; replace: boolean; to: string };
  expect(call.to).toBe('/admin');
  expect(call.replace).toBe(true);
  return call.search(previous);
};

describe('useIntegrationHealthSearchParams', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.search = {};
  });

  it('reads the state from the URL', () => {
    mocks.search = { healthRange: '7d', healthIntegration: 'jira' };
    const { result } = renderHook(() => useIntegrationHealthSearchParams());
    expect(result.current.timeRange).toBe('7d');
    expect(result.current.expandedIntegration).toBe('jira');
  });

  it('falls back to the defaults for an invalid param', () => {
    mocks.search = { healthRange: 'forever', healthIntegration: 'bogus' };
    const { result } = renderHook(() => useIntegrationHealthSearchParams());
    expect(result.current.timeRange).toBe('24h');
    expect(result.current.expandedIntegration).toBeNull();
  });

  it('writes a patch with replace, keeping unrelated params', () => {
    const { result } = renderHook(() => useIntegrationHealthSearchParams());
    act(() => result.current.patch({ timeRange: '30d' }));
    expect(lastSearchUpdate({ tab: 'integration-health', healthIntegration: 'slack' })).toEqual({
      tab: 'integration-health',
      healthRange: '30d',
      healthIntegration: 'slack',
    });
  });

  it('removes the param on collapse and on the default range', () => {
    const { result } = renderHook(() => useIntegrationHealthSearchParams());
    act(() => result.current.patch({ expandedIntegration: null, timeRange: '24h' }));
    const next = lastSearchUpdate({ healthRange: '7d', healthIntegration: 'github' });
    expect(next.healthRange).toBeUndefined();
    expect(next.healthIntegration).toBeUndefined();
  });
});
