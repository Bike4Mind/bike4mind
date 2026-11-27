import type { AxiosInstance } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPLETION_RUNS_PATH,
  MINT_FAILURE_BACKOFF_MS,
  RunBudgetNotRaisedError,
  createCompletionRunMinter,
  fetchRunBudget,
  raiseRunBudget,
  readCompletionRunUsage,
  requestCompletionRun,
} from './completionRuns';

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
    const request = vi.fn().mockResolvedValue(RUN);
    const mint = createCompletionRunMinter(vi.fn(), request);
    const axios = axiosWith(vi.fn());

    await expect(mint('local-run', axios, 'root-1')).resolves.toEqual(RUN);
    await expect(mint('local-run', axios, 'root-1')).resolves.toEqual(RUN);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('answers without a request for a while after a failed mint, then tries again', async () => {
    let clock = 1_000;
    const request = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(RUN);
    const mint = createCompletionRunMinter(vi.fn(), request, () => clock);
    const axios = axiosWith(vi.fn());

    await expect(mint('local-run', axios, 'root-1')).resolves.toBeUndefined();
    clock += MINT_FAILURE_BACKOFF_MS - 1;
    await expect(mint('local-run', axios, 'root-1')).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
    await expect(mint('other-run', axios, 'root-2')).resolves.toEqual(RUN);
    expect(request).toHaveBeenCalledTimes(2);

    request.mockResolvedValueOnce(RUN);
    clock += 1;
    await expect(mint('local-run', axios, 'root-1')).resolves.toEqual(RUN);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('keeps different roots apart', async () => {
    const request = vi.fn().mockResolvedValue(RUN);
    const mint = createCompletionRunMinter(vi.fn(), request);
    const axios = axiosWith(vi.fn());
    await Promise.all([mint('a', axios, 'root-a'), mint('b', axios, 'root-b')]);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('readCompletionRunUsage', () => {
  const spend = {
    creditsCharged: 3,
    requests: 2,
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const USAGE = {
    runId: RUN.runId,
    rootSessionId: 'root-1',
    createdAt: RUN.createdAt,
    settled: spend,
    byRole: [{ ...spend, role: 'root' }],
    byPurpose: [{ ...spend, purpose: 'turn' }],
    byModel: [{ ...spend, model: 'claude-sonnet' }],
    byAttempt: [{ ...spend, role: 'root' }],
    byAttemptTruncated: false,
  };
  const axiosGet = (get: ReturnType<typeof vi.fn>) => ({ get }) as unknown as AxiosInstance;

  it('reads the run usage and returns it parsed', async () => {
    const get = vi.fn().mockResolvedValue({ status: 200, data: USAGE });
    await expect(readCompletionRunUsage(axiosGet(get), RUN.runId)).resolves.toEqual({ ok: true, usage: USAGE });
    expect(get).toHaveBeenCalledWith(`${COMPLETION_RUNS_PATH}/${RUN.runId}/usage`, expect.anything());
  });

  it('says why when the request fails', async () => {
    const get = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(readCompletionRunUsage(axiosGet(get), RUN.runId)).resolves.toEqual({ ok: false, reason: 'offline' });
  });

  it('refuses a response that is not run usage', async () => {
    const get = vi.fn().mockResolvedValue({ status: 200, data: { runId: RUN.runId } });
    const result = await readCompletionRunUsage(axiosGet(get), RUN.runId);
    expect(result.ok).toBe(false);
  });
});

describe('run budgets', () => {
  const BUDGET = { budgetCredits: 500, committedCredits: 410, reservedCredits: 60, remainingCredits: 90 };

  it('mints with the budget when one is given, and without the field otherwise', async () => {
    const post = vi.fn().mockResolvedValue({ status: 201, data: { ...RUN, budgetCredits: 500 } });
    await requestCompletionRun(axiosWith(post), 'root-1', vi.fn(), 500);
    await requestCompletionRun(axiosWith(post), 'root-1', vi.fn());
    expect(post.mock.calls.map(call => call[1])).toEqual([
      { rootSessionId: 'root-1', budgetCredits: 500 },
      { rootSessionId: 'root-1' },
    ]);
  });

  it('passes the budget through the minter', async () => {
    const request = vi.fn().mockResolvedValue(RUN);
    const mint = createCompletionRunMinter(vi.fn(), request);
    await mint('local-1', axiosWith(vi.fn()), 'root-1', 750);
    expect(request).toHaveBeenCalledWith(expect.anything(), 'root-1', expect.any(Function), 750, undefined);
  });

  const spend = {
    creditsCharged: 0,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const usage = {
    runId: RUN.runId,
    createdAt: RUN.createdAt,
    settled: spend,
    byRole: [],
    byPurpose: [],
    byModel: [],
    byAttempt: [],
    byAttemptTruncated: false,
  };

  it("reads the budget from the run's usage", async () => {
    const get = vi.fn().mockResolvedValue({ data: { ...usage, budget: BUDGET } });
    await expect(fetchRunBudget({ get } as unknown as AxiosInstance, RUN.runId)).resolves.toEqual(BUDGET);
    expect(get).toHaveBeenCalledWith(`${COMPLETION_RUNS_PATH}/${RUN.runId}/usage`, expect.anything());
  });

  it('reads no budget for a run minted without one', async () => {
    const get = vi.fn().mockResolvedValue({ data: usage });
    await expect(fetchRunBudget({ get } as unknown as AxiosInstance, RUN.runId)).resolves.toBeUndefined();
  });

  it('throws when the usage read fails', async () => {
    const get = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(fetchRunBudget({ get } as unknown as AxiosInstance, RUN.runId)).rejects.toThrow('offline');
  });

  it('raises the budget, and names a change that is not a raise', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockRejectedValueOnce(
        Object.assign(new Error('Conflict'), {
          isAxiosError: true,
          response: { status: 409, data: { error: 'Not raised', errorCode: 'run_budget_not_raised' } },
        })
      );
    await raiseRunBudget(axiosWith(post), RUN.runId, 1000);
    expect(post).toHaveBeenCalledWith(
      `${COMPLETION_RUNS_PATH}/${RUN.runId}/budget`,
      { budgetCredits: 1000 },
      expect.anything()
    );
    await expect(raiseRunBudget(axiosWith(post), RUN.runId, 900)).rejects.toBeInstanceOf(RunBudgetNotRaisedError);
  });
});

describe('run payer', () => {
  const ORG = { organization_id: 'org-1' };
  const PERSONAL = { organization_id: null };

  it('binds a minted run to an organization, and omits the field for Personal', async () => {
    const post = vi.fn().mockResolvedValue({ status: 201, data: RUN });
    await requestCompletionRun(axiosWith(post), 'root-1', vi.fn(), undefined, ORG);
    await requestCompletionRun(axiosWith(post), 'root-1', vi.fn(), undefined, PERSONAL);
    expect(post.mock.calls.map(call => call[1])).toEqual([
      { rootSessionId: 'root-1', organization_id: 'org-1' },
      { rootSessionId: 'root-1' },
    ]);
  });

  it('passes the payer through the minter', async () => {
    const request = vi.fn().mockResolvedValue(RUN);
    const mint = createCompletionRunMinter(vi.fn(), request);
    await mint('local-1', axiosWith(vi.fn()), 'root-1', undefined, ORG);
    expect(request).toHaveBeenCalledWith(expect.anything(), 'root-1', expect.any(Function), undefined, ORG);
  });

  it("names an organization run's payer on its usage and budget reads", async () => {
    const get = vi.fn().mockRejectedValue(new Error('offline'));
    const post = vi.fn().mockResolvedValue({ status: 200, data: {} });
    const axios = { get, post } as unknown as AxiosInstance;

    await readCompletionRunUsage(axios, RUN.runId, ORG);
    await readCompletionRunUsage(axios, RUN.runId, PERSONAL);
    await raiseRunBudget(axios, RUN.runId, 1000, ORG);

    expect(get.mock.calls.map(call => call[0])).toEqual([
      `${COMPLETION_RUNS_PATH}/${RUN.runId}/usage?organization_id=org-1`,
      `${COMPLETION_RUNS_PATH}/${RUN.runId}/usage`,
    ]);
    // The budget route validates its payer from the body, so the query must carry none.
    expect(post).toHaveBeenCalledWith(
      `${COMPLETION_RUNS_PATH}/${RUN.runId}/budget`,
      { budgetCredits: 1000, organization_id: 'org-1' },
      expect.anything()
    );
  });

  it('raises a Personal run with no organization in the budget body', async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, data: {} });
    await raiseRunBudget(axiosWith(post), RUN.runId, 1000, PERSONAL);
    expect(post).toHaveBeenCalledWith(
      `${COMPLETION_RUNS_PATH}/${RUN.runId}/budget`,
      { budgetCredits: 1000 },
      expect.anything()
    );
  });
});
