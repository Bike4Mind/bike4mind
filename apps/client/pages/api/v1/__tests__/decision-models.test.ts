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
vi.mock('@server/decisions/providers', () => ({
  getDecisionProviderRegistry: () => ({ models: () => ['gpt-6-luna'] }),
}));

import handler from '../decision-models';

describe('GET /api/v1/decision-models', () => {
  it('lists only the registered models, in the public wire shape', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);

    const body = ListDecisionModelsResponseSchema.parse(res._getJSONData());
    expect(body.models.map(model => model.id)).toEqual(['gpt-6-luna']);
    expect(body.models[0]).toMatchObject({ object: 'decision_model', provider: 'openai', alias_of: null });
  });
});
