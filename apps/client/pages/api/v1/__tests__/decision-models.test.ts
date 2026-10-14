import { ListDecisionModelsResponseSchema } from '@bike4mind/common';
import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(async (req: unknown, res: unknown) => h.GET?.(req, res), {
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => vi.fn() }));
const { registeredModels, callableProviders } = vi.hoisted(() => ({
  registeredModels: { value: [] as string[] },
  callableProviders: { value: [] as string[] },
}));
vi.mock('@server/decisions/providers', () => ({
  getDecisionProviderRegistry: () => ({ models: () => registeredModels.value }),
  resolveCallableDecisionProviders: vi.fn(async () => new Set(callableProviders.value)),
}));

import { resolveCallableDecisionProviders } from '@server/decisions/providers';
import handler from '../decision-models';

const callHandler = async () => {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user: { id: 'user-1' }, logger: {} });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

const listModels = async () => ListDecisionModelsResponseSchema.parse((await callHandler())._getJSONData());

describe('GET /api/v1/decision-models', () => {
  beforeEach(() => {
    registeredModels.value = ['gpt-6-luna'];
    callableProviders.value = ['openai', 'typesafe', 'test'];
    vi.mocked(resolveCallableDecisionProviders).mockClear();
  });

  it("filters by the caller's own keys, asking once per distinct provider", async () => {
    registeredModels.value = ['gpt-6-luna', 'jev-1.13.0', 'jev-latest'];
    await listModels();
    expect(resolveCallableDecisionProviders).toHaveBeenCalledTimes(1);
    expect(resolveCallableDecisionProviders).toHaveBeenLastCalledWith(
      'user-1',
      ['openai', 'typesafe'],
      expect.anything()
    );
  });

  // Failing open would list models that then answer 503 provider_not_configured.
  it('fails rather than listing every model when the key lookup fails', async () => {
    vi.mocked(resolveCallableDecisionProviders).mockRejectedValueOnce(new Error('db'));
    await expect(callHandler()).rejects.toThrow('db');
  });

  it('exposes the jev-latest alias target and that it takes no images', async () => {
    registeredModels.value = ['jev-latest'];
    const [model] = (await listModels()).models;
    expect(model).toMatchObject({
      id: 'jev-latest',
      provider: 'typesafe',
      alias_of: 'jev-1.13.0',
      supports_images: false,
    });
  });

  it('lists only the registered models, in the public wire shape', async () => {
    const body = await listModels();
    expect(body.models.map(model => model.id)).toEqual(['gpt-6-luna']);
    expect(body.models[0]).toMatchObject({ object: 'decision_model', provider: 'openai', alias_of: null });
  });

  it('hides the models of a provider the caller has no key for', async () => {
    registeredModels.value = ['gpt-6-luna', 'jev-1.13.0', 'jev-latest'];
    callableProviders.value = ['openai'];
    expect((await listModels()).models.map(model => model.id)).toEqual(['gpt-6-luna']);

    callableProviders.value = ['openai', 'typesafe'];
    expect((await listModels()).models.map(model => model.id)).toEqual(['gpt-6-luna', 'jev-1.13.0', 'jev-latest']);
  });
});
