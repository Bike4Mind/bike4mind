import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  MODEL_ACCESS_REFETCH_JITTER_MS,
  MODEL_CONFIGURATIONS_QUERY_KEY,
  handleModelAccessRevisionSetting,
  watchModelAccessArrivals,
} from './modelAccessRevision';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));

const entriesAt = (revision: string | null) => ({ configurations: [], revision });
const pushed = (settingValue: unknown, settingName = 'modelAccessRevision') => ({ settingName, settingValue });
const REFETCH_ALL = [{ queryKey: MODEL_CONFIGURATIONS_QUERY_KEY, refetchType: 'all' }, { throwOnError: true }] as const;

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
    queryClient.clear();
  });

  it('refetches entries read under a different revision within the jitter window', () => {
    queryClient.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-1'));

    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0.5);
    vi.advanceTimersByTime(MODEL_ACCESS_REFETCH_JITTER_MS / 2 - 1);
    expect(invalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(invalidate).toHaveBeenCalledWith(...REFETCH_ALL);
  });

  it('refetches entries read before the first bump once a revision arrives', () => {
    queryClient.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt(null));

    handleModelAccessRevisionSetting(queryClient, pushed('acc-1'), () => 0);
    vi.runAllTimers();

    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('leaves entries alone that already match the replayed revision', () => {
    queryClient.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-1'));

    handleModelAccessRevisionSetting(queryClient, pushed('acc-1'), () => 0);
    vi.runAllTimers();

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('ignores other settings and empty values', () => {
    queryClient.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-1'));

    handleModelAccessRevisionSetting(queryClient, pushed('acc-2', 'modelListRevision'), () => 0);
    handleModelAccessRevisionSetting(queryClient, pushed(''), () => 0);
    handleModelAccessRevisionSetting(queryClient, pushed(42), () => 0);
    vi.runAllTimers();

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('refetches once per revision, however often it is pushed, and again for a newer one', () => {
    queryClient.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-1'));

    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0);
    vi.runAllTimers();
    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0);
    vi.runAllTimers();
    expect(invalidate).toHaveBeenCalledTimes(1);

    handleModelAccessRevisionSetting(queryClient, pushed('acc-3'), () => 0);
    vi.runAllTimers();
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('tries the revision again after a refetch that came back with no revision', async () => {
    queryClient.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-1'));
    invalidate.mockImplementation(async () => {
      queryClient.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt(null));
    });

    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0);
    await vi.runAllTimersAsync();
    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0);
    await vi.runAllTimersAsync();

    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('tries the revision again after a refetch that failed', async () => {
    queryClient.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-1'));
    invalidate.mockRejectedValueOnce(new Error('Offline'));

    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0);
    await vi.runAllTimersAsync();
    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0);
    await vi.runAllTimersAsync();

    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('skips the refetch when the entries caught up during the wait', () => {
    queryClient.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-1'));

    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0.5);
    queryClient.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-2'));
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
      queryKey: MODEL_CONFIGURATIONS_QUERY_KEY,
      queryFn: async () => entriesAt('acc-1'),
    });
    vi.runAllTimers();

    expect(invalidate).toHaveBeenCalledWith(...REFETCH_ALL);
    stop();
    queryClient.clear();
  });

  it('drops a pending refetch and stops observing arrivals once unsubscribed', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    const stop = watchModelAccessArrivals(queryClient, () => 0.5);
    queryClient.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-1'));

    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0.5);
    stop();
    vi.runAllTimers();

    expect(invalidate).not.toHaveBeenCalled();
    queryClient.clear();
  });

  describe('when the jitter timer fires during a fetch already in flight', () => {
    const setup = (queryFn: ReturnType<typeof vi.fn>) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
      const stop = watchModelAccessArrivals(queryClient, () => 0);
      queryClient.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-1'));
      const inFlight = queryClient
        .fetchQuery({ queryKey: MODEL_CONFIGURATIONS_QUERY_KEY, queryFn, staleTime: 0 })
        .catch(() => undefined);
      handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0);
      return { queryClient, stop, inFlight };
    };

    it('refetches the revision after that fetch fails', async () => {
      let fail: (error: Error) => void = () => undefined;
      const queryFn = vi
        .fn()
        .mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
        .mockResolvedValue(entriesAt('acc-2'));
      const { queryClient, stop, inFlight } = setup(queryFn);

      await vi.advanceTimersByTimeAsync(0);
      expect(queryFn).toHaveBeenCalledTimes(1);
      fail(new Error('Offline'));
      await inFlight;
      await vi.runAllTimersAsync();

      expect(queryFn).toHaveBeenCalledTimes(2);
      expect(queryClient.getQueryData(MODEL_CONFIGURATIONS_QUERY_KEY)).toEqual(entriesAt('acc-2'));
      stop();
      queryClient.clear();
    });

    it('is satisfied by that fetch when it lands on the pushed revision', async () => {
      let land: (value: unknown) => void = () => undefined;
      const queryFn = vi.fn().mockImplementationOnce(() => new Promise(resolve => (land = resolve)));
      const { queryClient, stop, inFlight } = setup(queryFn);

      await vi.advanceTimersByTimeAsync(0);
      land(entriesAt('acc-2'));
      await inFlight;
      await vi.runAllTimersAsync();

      expect(queryFn).toHaveBeenCalledTimes(1);
      stop();
      queryClient.clear();
    });

    it('refetches once more when that fetch lands on a stale revision', async () => {
      let land: (value: unknown) => void = () => undefined;
      const queryFn = vi
        .fn()
        .mockImplementationOnce(() => new Promise(resolve => (land = resolve)))
        .mockResolvedValue(entriesAt('acc-2'));
      const { queryClient, stop, inFlight } = setup(queryFn);

      await vi.advanceTimersByTimeAsync(0);
      land(entriesAt('acc-1'));
      await inFlight;
      await vi.runAllTimersAsync();

      expect(queryFn).toHaveBeenCalledTimes(2);
      stop();
      queryClient.clear();
    });
  });

  it('does not loop on a server that keeps failing', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const stop = watchModelAccessArrivals(queryClient, () => 0);
    const queryFn = vi.fn().mockRejectedValue(new Error('Server down'));
    queryClient.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, entriesAt('acc-1'));
    queryClient
      .getQueryCache()
      .find({ queryKey: MODEL_CONFIGURATIONS_QUERY_KEY })
      ?.setOptions({ queryFn, retry: false });

    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0);
    await vi.runAllTimersAsync();
    expect(queryFn).toHaveBeenCalledTimes(1);

    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0);
    await vi.runAllTimersAsync();
    expect(queryFn).toHaveBeenCalledTimes(2);
    stop();
    queryClient.clear();
  });

  it('refetches a picker query no mounted observer is watching', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const stop = watchModelAccessArrivals(queryClient, () => 0);
    const queryFn = vi.fn().mockResolvedValueOnce(entriesAt('acc-1')).mockResolvedValue(entriesAt('acc-2'));
    await queryClient.fetchQuery({ queryKey: MODEL_CONFIGURATIONS_QUERY_KEY, queryFn });
    expect(queryClient.getQueryCache().find({ queryKey: MODEL_CONFIGURATIONS_QUERY_KEY })?.isActive()).toBe(false);

    handleModelAccessRevisionSetting(queryClient, pushed('acc-2'), () => 0);
    await vi.runAllTimersAsync();

    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(MODEL_CONFIGURATIONS_QUERY_KEY)).toEqual(entriesAt('acc-2'));
    stop();
    queryClient.clear();
  });
});
