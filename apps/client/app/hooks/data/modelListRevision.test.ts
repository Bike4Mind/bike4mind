import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { MODEL_CATALOG_QUERY_KEY } from './useModelInfo';
import { MODEL_LIST_REFETCH_JITTER_MS, handleModelListRevisionSetting } from './modelListRevision';

const catalogAt = (modelListRevision: string | null) => ({
  models: [],
  supersededModels: [],
  lockedModels: [],
  modelListRevision,
});

const pushed = (settingValue: unknown, settingName = 'modelListRevision') => ({ settingName, settingValue });

describe('handleModelListRevisionSetting', () => {
  let queryClient: QueryClient;
  let invalidate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient();
    invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refetches a list built under an older revision, within the jitter window', () => {
    queryClient.setQueryData(MODEL_CATALOG_QUERY_KEY, catalogAt('rev-1'));

    handleModelListRevisionSetting(queryClient, pushed('rev-2'), () => 0.5);
    expect(invalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MODEL_LIST_REFETCH_JITTER_MS);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: MODEL_CATALOG_QUERY_KEY });
  });

  it('refetches a list built before any revision existed', () => {
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

  it('does nothing before the first model-list fetch', () => {
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

  it('ignores other settings and empty values', () => {
    queryClient.setQueryData(MODEL_CATALOG_QUERY_KEY, catalogAt('rev-1'));

    handleModelListRevisionSetting(queryClient, pushed('rev-2', 'EnableArtifacts'));
    handleModelListRevisionSetting(queryClient, pushed(''));
    handleModelListRevisionSetting(queryClient, pushed(undefined));
    vi.runAllTimers();

    expect(invalidate).not.toHaveBeenCalled();
  });
});
