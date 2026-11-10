import type { AxiosInstance } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { COMPLETION_RUNS_PATH, createCompletionRunMinter, requestCompletionRun } from './completionRuns';

const RUN = {
  runId: '7d0c8f3e-2b1a-4c5d-9e8f-0a1b2c3d4e5f',
  rootSessionId: 'root-1',
  createdAt: '2026-11-10T00:00:00.000Z',
};

function axiosWith(post: ReturnType<typeof vi.fn>): AxiosInstance {
  return { post } as unknown as AxiosInstance;
}

describe('requestCompletionRun', () => {
  it('posts the root session and returns the parsed run', async () => {
    const post = vi.fn().mockResolvedValue({ status: 201, data: RUN });
    await expect(requestCompletionRun(axiosWith(post), 'root-1', vi.fn())).resolves.toEqual(RUN);
    expect(post).toHaveBeenCalledWith(COMPLETION_RUNS_PATH, { rootSessionId: 'root-1' }, expect.anything());
  });

  it('returns undefined and reports a failed request', async () => {
    const onError = vi.fn();
    const post = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(requestCompletionRun(axiosWith(post), 'root-1', onError)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith('offline');
  });

  it('returns undefined for a response that is not a run', async () => {
    const onError = vi.fn();
    const post = vi.fn().mockResolvedValue({ status: 201, data: { runId: 'not-a-uuid' } });
    await expect(requestCompletionRun(axiosWith(post), 'root-1', onError)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('createCompletionRunMinter', () => {
  it('shares one request between concurrent mints for the same root', async () => {
    let resolve!: (value: typeof RUN) => void;
    const request = vi.fn().mockReturnValue(new Promise<typeof RUN>(done => (resolve = done)));
    const mint = createCompletionRunMinter(vi.fn(), request);
    const axios = axiosWith(vi.fn());

    const first = mint('local-run', axios, 'root-1');
    const second = mint('local-run', axios, 'root-1');
    resolve(RUN);

    await expect(Promise.all([first, second])).resolves.toEqual([RUN, RUN]);
    expect(request).toHaveBeenCalledOnce();
  });

  it('mints again once the earlier request has settled', async () => {
    const request = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(RUN);
    const mint = createCompletionRunMinter(vi.fn(), request);
    const axios = axiosWith(vi.fn());

    await expect(mint('local-run', axios, 'root-1')).resolves.toBeUndefined();
    await expect(mint('local-run', axios, 'root-1')).resolves.toEqual(RUN);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps different roots apart', async () => {
    const request = vi.fn().mockResolvedValue(RUN);
    const mint = createCompletionRunMinter(vi.fn(), request);
    const axios = axiosWith(vi.fn());
    await Promise.all([mint('a', axios, 'root-a'), mint('b', axios, 'root-b')]);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
