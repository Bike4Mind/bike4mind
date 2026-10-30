import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('@tanstack/react-router', async () => (await import('./__tests__/fakeAdminRouter')).fakeRouterModule);

import { fakeAdminRouter } from './__tests__/fakeAdminRouter';
import { useModelLogsView } from './useModelLogsView';

describe('useModelLogsView', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00'));
    act(() => fakeAdminRouter.reset({ tab: 'model-logs' }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = () => renderHook(() => useModelLogsView());

  it('leaves a page loaded from the URL alone on mount', () => {
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: 4, modelLogsModel: 'gpt-4' }));
    const { result } = setup();

    expect(result.current[0]).toMatchObject({ page: 4, model: 'gpt-4' });
    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
  });

  it('resets the page in the same navigation as a filter change', () => {
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', modelLogsPage: 4 }));
    const { result } = setup();

    act(() => result.current[1]({ model: 'claude-3-opus', page: 1 }));

    expect(fakeAdminRouter.navigate).toHaveBeenCalledTimes(1);
    expect(fakeAdminRouter.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ replace: true }));
    expect(fakeAdminRouter.search).toEqual({ tab: 'model-logs', modelLogsModel: 'claude-3-opus' });
  });

  it('writes a custom range and page size, and drops them again at their defaults', () => {
    const { result } = setup();

    act(() => result.current[1]({ startDate: '2026-09-01', endDate: '2026-09-30', limit: 25 }));
    expect(fakeAdminRouter.search).toEqual({
      tab: 'model-logs',
      modelLogsFrom: '2026-09-01',
      modelLogsTo: '2026-09-30',
      modelLogsLimit: 25,
    });

    act(() => result.current[1]({ startDate: '2026-10-15', endDate: '2026-10-21', limit: 10 }));
    expect(fakeAdminRouter.search).toEqual({ tab: 'model-logs' });
  });

  it('leaves other tabs and console params alone', () => {
    act(() => fakeAdminRouter.reset({ tab: 'model-logs', emergency_access: 'true' }));
    const { result } = setup();

    act(() => result.current[1]({ page: 2 }));

    expect(fakeAdminRouter.search).toEqual({ tab: 'model-logs', emergency_access: 'true', modelLogsPage: 2 });
  });
});
