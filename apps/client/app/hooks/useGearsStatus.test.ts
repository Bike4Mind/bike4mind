import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn() },
}));

import {
  invalidateGearsStatusWhileLocked,
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
