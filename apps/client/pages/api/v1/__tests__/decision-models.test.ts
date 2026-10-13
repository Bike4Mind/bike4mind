import { ListDecisionModelsResponseSchema } from '@bike4mind/common';
import { createMocks } from 'node-mocks-http';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(async (req: unknown, res: unknown) => h.GET?.(req, res), {
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => vi.fn() }));
const { registeredModels } = vi.hoisted(() => ({ registeredModels: { value: ['gpt-6-luna'] as string[] } }));
vi.mock('@server/decisions/providers', () => ({
  getDecisionProviderRegistry: () => ({ models: () => registeredModels.value }),
}));

import handler from '../decision-models';

const listModels = async () => {
  const { req, res } = createMocks({ method: 'GET' });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return ListDecisionModelsResponseSchema.parse(res._getJSONData());
};

describe('GET /api/v1/decision-models', () => {
  it('exposes the jev-latest alias target and that it takes no images', async () => {
    registeredModels.value = ['jev-latest'];
    const [model] = (await listModels()).models;
    expect(model).toMatchObject({
      id: 'jev-latest',
      provider: 'typesafe',
      alias_of: 'jev-1.13.0',
      supports_images: false,
    });
    registeredModels.value = ['gpt-6-luna'];
  });

  it('lists only the registered models, in the public wire shape', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);

    const body = ListDecisionModelsResponseSchema.parse(res._getJSONData());
    expect(body.models.map(model => model.id)).toEqual(['gpt-6-luna']);
    expect(body.models[0]).toMatchObject({ object: 'decision_model', provider: 'openai', alias_of: null });
  });
});
