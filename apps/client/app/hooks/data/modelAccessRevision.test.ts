import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { LLM_MODEL_CONFIGURATIONS_QUERY_KEY } from './llmModelConfig';
import {
  MODEL_ACCESS_REFETCH_JITTER_MS,
  handleModelAccessRevisionSetting,
  watchModelAccessArrivals,
} from './modelAccessRevision';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));

const entriesAt = (revision: string | null) => ({ configurations: [], revision });
const pushed = (settingValue: unknown, settingName = 'modelAccessRevision') => ({ settingName, settingValue });

describe('handleModelAccessRevisionSetting', () => {
  let queryClient: QueryClient;
  let invalidate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refetches entries read under a different revision within the jitter window', () => {
    queryClient.setQueryData(LLM_MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-1'));

    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0.5);
    vi.advanceTimersByTime(MODEL_ACCESS_REFETCH_JITTER_MS / 2 - 1);
    expect(invalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: LLM_MODEL_CONFIGURATIONS_QUERY_KEY });
  });

  it('refetches entries read before the first bump once a revision arrives', () => {
    queryClient.setQueryData(LLM_MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt(null));

    handleModelAccessRevisionSetting(queryClient, pushed('acc-1'), () => 0);
    vi.runAllTimers();

    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('leaves entries alone that already match the replayed revision', () => {
    queryClient.setQueryData(LLM_MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-1'));

    handleModelAccessRevisionSetting(queryClient, pushed('acc-1'), () => 0);
    vi.runAllTimers();

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('ignores other settings and empty values', () => {
    queryClient.setQueryData(LLM_MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-1'));

    handleModelAccessRevisionSetting(queryClient, pushed('acc-2', 'modelListRevision'), () => 0);
    handleModelAccessRevisionSetting(queryClient, pushed(''), () => 0);
    handleModelAccessRevisionSetting(queryClient, pushed(42), () => 0);
    vi.runAllTimers();

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('refetches once per revision, however often it is pushed', () => {
    queryClient.setQueryData(LLM_MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-1'));

    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0);
    vi.runAllTimers();
    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0);
    vi.runAllTimers();

    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('skips the refetch when the entries caught up during the wait', () => {
    queryClient.setQueryData(LLM_MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-1'));

    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0.5);
    queryClient.setQueryData(LLM_MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-2'));
    vi.runAllTimers();

    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('watchModelAccessArrivals', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('checks a revision pushed before the first read once the entries land', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    const stop = watchModelAccessArrivals(queryClient, () => 0);

    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0);
    await queryClient.fetchQuery({
      queryKey: LLM_MODEL_CONFIGURATIONS_QUERY_KEY,
      queryFn: async () => entriesAt('acc-1'),
    });
    vi.runAllTimers();

    expect(invalidate).toHaveBeenCalledWith({ queryKey: LLM_MODEL_CONFIGURATIONS_QUERY_KEY });
    stop();
  });
});
