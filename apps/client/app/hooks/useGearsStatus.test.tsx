import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, act } from '@testing-library/react';

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: apiPost },
}));

import {
  invalidateGearsStatusWhileLocked,
  useClaimGear,
  type GearKey,
  type GearStatus,
  type GearsStatusResponse,
} from './useGearsStatus';

const gear = (key: GearKey, unlocked: boolean): GearStatus => ({
  key,
  kind: 'destination',
  unlocked,
  credits: 0,
  title: key,
  tagline: '',
  intro: '',
  cta: '',
  ctaAction: '',
});

const seed = (queryClient: QueryClient, gears: GearStatus[]) => {
  const response: GearsStatusResponse = {
    gears,
    totalUnlocked: gears.filter(g => g.unlocked).length,
  };
  queryClient.setQueryData(['gears', 'status'], response);
};

describe('invalidateGearsStatusWhileLocked', () => {
  let queryClient: QueryClient;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
  });

  it('invalidates when the target gear is cached and still locked', () => {
    seed(queryClient, [gear('datalakes', false)]);
    invalidateGearsStatusWhileLocked(queryClient, ['datalakes']);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['gears', 'status'] });
  });

  it('does not invalidate once the target gear is already unlocked', () => {
    seed(queryClient, [gear('datalakes', true)]);
    invalidateGearsStatusWhileLocked(queryClient, ['datalakes']);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('does nothing when no status is cached (no observers to update)', () => {
    invalidateGearsStatusWhileLocked(queryClient, ['datalakes']);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('invalidates when any one of several gears is still locked', () => {
    seed(queryClient, [gear('datalakes', true), gear('files', false)]);
    invalidateGearsStatusWhileLocked(queryClient, ['datalakes', 'files']);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate when every listed gear is unlocked', () => {
    seed(queryClient, [gear('datalakes', true), gear('files', true)]);
    invalidateGearsStatusWhileLocked(queryClient, ['datalakes', 'files']);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('does not invalidate when the listed gear is absent from the cached status', () => {
    seed(queryClient, [gear('files', true)]);
    invalidateGearsStatusWhileLocked(queryClient, ['datalakes']);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('useClaimGear', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const claimable = (key: GearKey) => ({ ...gear(key, true), claimable: true });
  const cachedClaimable = (key: GearKey) =>
    queryClient.getQueryData<GearsStatusResponse>(['gears', 'status'])?.gears.find(g => g.key === key)?.claimable;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    apiPost.mockReset();
    seed(queryClient, [claimable('projects'), claimable('agents')]);
  });

  it('posts the key, then clears only that gear in the cache and refetches the status', async () => {
    apiPost.mockResolvedValue({ data: { key: 'projects', creditsAwarded: 1000 } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useClaimGear(), { wrapper });

    await act(() => result.current.mutateAsync('projects'));

    expect(apiPost).toHaveBeenCalledWith('/api/gears/claim', { key: 'projects' });
    expect(cachedClaimable('projects')).toBe(false);
    expect(cachedClaimable('agents')).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['gears', 'status'] });
  });

  it('leaves the gear claimable when the claim fails, so the button stays for a retry', async () => {
    apiPost.mockRejectedValue(new Error('500'));
    const { result } = renderHook(() => useClaimGear(), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync('projects')).rejects.toThrow('500');
    });

    expect(cachedClaimable('projects')).toBe(true);
  });
});
