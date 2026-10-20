/**
 * The CLI's hide-the-tool probe. `decide` is only offered when the deployment reports a model this
 * caller can call, so the empty-list, failed-request and cache branches are the whole behavior.
 * `vi.resetModules()` gives each case its own process-wide cache.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ApiClient } from '../auth/ApiClient';

const debug = vi.hoisted(() => vi.fn());
vi.mock('./Logger', () => ({ logger: { debug } }));

const load = async () => {
  vi.resetModules();
  return import('./decisionModelProbe.js');
};

// ApiClient.get is generic, so a plain mock is not assignable to it.
const getWith = (impl: () => Promise<unknown>) => ({ get: vi.fn(impl) }) as unknown as Pick<ApiClient, 'get'>;

describe('hasDecisionModels', () => {
  it('is true when the deployment lists a model', async () => {
    const { hasDecisionModels } = await load();
    expect(await hasDecisionModels(getWith(async () => ({ models: [{ id: 'gpt-6-luna' }] })))).toBe(true);
  });

  it('is false for an empty model list', async () => {
    const { hasDecisionModels } = await load();
    expect(await hasDecisionModels(getWith(async () => ({ models: [] })))).toBe(false);
  });

  it('is false for a body without a models array', async () => {
    const { hasDecisionModels } = await load();
    expect(await hasDecisionModels(getWith(async () => ({ models: 'yes' })))).toBe(false);
  });

  it('is false when the request fails, and does not cache the no', async () => {
    const { hasDecisionModels } = await load();
    const apiClient = {
      get: vi
        .fn()
        .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
        .mockResolvedValueOnce({ models: [{ id: 'gpt-6-luna' }] }),
    };

    debug.mockClear();
    expect(await hasDecisionModels(apiClient)).toBe(false);
    expect(debug).toHaveBeenCalledExactlyOnceWith(
      '[decide] Decision-model availability lookup failed; hiding the tool until the next build.'
    );
    // The retry proves the failed probe cleared the cache instead of pinning a no for the process.
    expect(await hasDecisionModels(apiClient)).toBe(true);
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('caches a yes for the process', async () => {
    const { hasDecisionModels } = await load();
    const apiClient = getWith(async () => ({ models: [{ id: 'gpt-6-luna' }] }));

    expect(await hasDecisionModels(apiClient)).toBe(true);
    expect(await hasDecisionModels(apiClient)).toBe(true);
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });
});
