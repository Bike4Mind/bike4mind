import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { MODEL_CATALOG_QUERY_KEY } from './useModelInfo';
import {
  MODEL_LIST_REFETCH_JITTER_MS,
  handleModelListRevisionSetting,
  watchModelListArrivals,
} from './modelListRevision';

const catalogAt = (modelListRevision: string | null) => ({
  models: [],
  supersededModels: [],
  lockedModels: [],
  modelListRevision,
  catalogUnavailable: false,
});

const pushed = (settingValue: unknown, settingName = 'modelListRevision') => ({ settingName, settingValue });

describe('handleModelListRevisionSetting', () => {
  let queryClient: QueryClient;
  let invalidate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // runAllTimers would otherwise also fire the cache GC and drop the unobserved list.
    queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refetches a list built under a different revision, within the jitter window', () => {
    queryClient.setQueryData(MODEL_CATALOG_QUERY_KEY, catalogAt('rev-1'));

    handleModelListRevisionSetting(queryClient, pushed('rev-2'), () => 0.5);
    expect(invalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MODEL_LIST_REFETCH_JITTER_MS);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: MODEL_CATALOG_QUERY_KEY });
  });

  it('refetches a list that carries no revision', () => {
    queryClient.setQueryData(MODEL_CATALOG_QUERY_KEY, catalogAt(null));

    handleModelListRevisionSetting(queryClient, pushed('rev-1'), () => 0);
    vi.runAllTimers();

    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the replayed row matches the list on screen', () => {
    queryClient.setQueryData(MODEL_CATALOG_QUERY_KEY, catalogAt('rev-1'));

    handleModelListRevisionSetting(queryClient, pushed('rev-1'));
    vi.runAllTimers();

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('skips the refetch when the list caught up during the wait', () => {
    queryClient.setQueryData(MODEL_CATALOG_QUERY_KEY, catalogAt('rev-1'));

    handleModelListRevisionSetting(queryClient, pushed('rev-2'), () => 1);
    queryClient.setQueryData(MODEL_CATALOG_QUERY_KEY, catalogAt('rev-2'));
    vi.runAllTimers();

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('spends one refetch per pushed revision, even if the list still differs after it', () => {
    queryClient.setQueryData(MODEL_CATALOG_QUERY_KEY, catalogAt('rev-1'));

    handleModelListRevisionSetting(queryClient, pushed('rev-2'), () => 0);
    vi.runAllTimers();
    handleModelListRevisionSetting(queryClient, pushed('rev-2'), () => 0);
    vi.runAllTimers();
    expect(invalidate).toHaveBeenCalledTimes(1);

    handleModelListRevisionSetting(queryClient, pushed('rev-3'), () => 0);
    vi.runAllTimers();
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('ignores other settings and empty values', () => {
    queryClient.setQueryData(MODEL_CATALOG_QUERY_KEY, catalogAt('rev-1'));

    handleModelListRevisionSetting(queryClient, pushed('rev-2', 'EnableArtifacts'));
    handleModelListRevisionSetting(queryClient, pushed(''));
    handleModelListRevisionSetting(queryClient, pushed(undefined));
    vi.runAllTimers();

    expect(invalidate).not.toHaveBeenCalled();
  });

  describe('with watchModelListArrivals', () => {
    it('refetches when the first list lands on an older revision than one pushed during the fetch', async () => {
      const unsubscribe = watchModelListArrivals(queryClient, () => 0);

      handleModelListRevisionSetting(queryClient, pushed('rev-2'), () => 0);
      vi.runAllTimers();
      expect(invalidate).not.toHaveBeenCalled();

      await queryClient.fetchQuery({ queryKey: MODEL_CATALOG_QUERY_KEY, queryFn: async () => catalogAt('rev-1') });
      vi.runAllTimers();

      expect(invalidate).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it('does nothing when the first list lands on the pushed revision', async () => {
      const unsubscribe = watchModelListArrivals(queryClient, () => 0);

      handleModelListRevisionSetting(queryClient, pushed('rev-2'));
      await queryClient.fetchQuery({ queryKey: MODEL_CATALOG_QUERY_KEY, queryFn: async () => catalogAt('rev-2') });
      vi.runAllTimers();

      expect(invalidate).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('ignores other queries landing', async () => {
      const unsubscribe = watchModelListArrivals(queryClient, () => 0);
      handleModelListRevisionSetting(queryClient, pushed('rev-2'));

      await queryClient.fetchQuery({ queryKey: ['adminsettings'], queryFn: async () => [] });
      vi.runAllTimers();

      expect(invalidate).not.toHaveBeenCalled();
      unsubscribe();
    });
  });
});
