import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  MODEL_CONFIGURATIONS_QUERY_KEY,
  handleModelAccessRevisionSetting,
  watchModelAccessArrivals,
} from './modelAccessRevision';

const read = (revision: string | null) => ({ configurations: [], revision });
const push = (client: QueryClient, revision: string) =>
  handleModelAccessRevisionSetting(client, { settingName: 'modelAccessRevision', settingValue: revision });
const clients: QueryClient[] = [];
const setup = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
  const stop = watchModelAccessArrivals(client);
  return { client, invalidate, stop };
};
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe('model access revision arrivals', () => {
  it('refreshes the picker query immediately without waiting for the model-list cache', () => {
    const { client, invalidate } = setup();
    client.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, read('r1'));
    push(client, 'r2');
    expect(invalidate).toHaveBeenCalledWith(
      { queryKey: MODEL_CONFIGURATIONS_QUERY_KEY, refetchType: 'all' },
      { throwOnError: true }
    );
  });

  it('waits for initial query arrival and deduplicates replayed pushes', () => {
    const { client, invalidate } = setup();
    push(client, 'r2');
    expect(invalidate).not.toHaveBeenCalled();
    client.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, read('r1'));
    push(client, 'r2');
    expect(invalidate).toHaveBeenCalledOnce();
    push(client, 'r3');
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('checks a push received while the first read is in flight when that response lands', async () => {
    const { client, invalidate } = setup();
    let finish: ((value: ReturnType<typeof read>) => void) | undefined;
    const pending = client.fetchQuery({
      queryKey: MODEL_CONFIGURATIONS_QUERY_KEY,
      queryFn: () =>
        new Promise<ReturnType<typeof read>>(resolve => {
          finish = resolve;
        }),
    });
    push(client, 'r2');
    expect(invalidate).not.toHaveBeenCalled();
    if (!finish) throw new Error('Query did not start');
    finish(read('r1'));
    await pending;
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('does not refresh a matching read or a different setting', () => {
    const { client, invalidate } = setup();
    client.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, read('r2'));
    push(client, 'r2');
    handleModelAccessRevisionSetting(client, { settingName: 'modelListRevision', settingValue: 'r3' });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('allows the same revision to retry after an explicit refresh failure', async () => {
    const { client, invalidate } = setup();
    client.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, read('r1'));
    invalidate.mockRejectedValueOnce(new Error('Offline'));
    push(client, 'r2');
    await Promise.resolve();
    push(client, 'r2');
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('stops observing query arrivals after unmount', () => {
    const { client, invalidate, stop } = setup();
    push(client, 'r2');
    stop();
    client.setQueryData(MODEL_CONFIGURATIONS_QUERY_KEY, read('r1'));
    expect(invalidate).not.toHaveBeenCalled();
  });
});
