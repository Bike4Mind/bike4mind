import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  rateLimitOpts: [] as Array<{ bucket?: string }>,
  findById: vi.fn(),
  getLlm: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const fn = (async (req: { method: string }, res: { status: (n: number) => { end: () => void } }) => {
      const handler = handlers[req.method];
      if (!handler) return res.status(405).end();
      return handler(req, res);
    }) as ((req: unknown, res: unknown) => unknown) & Record<string, (h: unknown) => unknown>;
    fn.use = () => fn;
    fn.post = (h: unknown) => ((handlers.POST = h as never), fn);
    return fn;
  },
}));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: vi.fn(async () => 30) }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (opts: { bucket?: string }) => (h.rateLimitOpts.push(opts), vi.fn()),
}));
vi.mock('@bike4mind/database', () => ({
  skillRepository: { findById: (...a: unknown[]) => h.findById(...a) },
  SkillListing: {},
}));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@server/skillMarket/classifySkill', () => ({
  getOperationsClassifierLlm: (...a: unknown[]) => h.getLlm(...a),
}));

import handler from '@pages/api/skills/market/suggest-tags';
import { NotFoundError } from '@bike4mind/common';

const USER = 'user-1';
const skill = { id: 'skill-1', userId: USER, name: 'fmt', description: 'Formats text', body: 'b' };

function makeReqRes(body: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: USER }, logger: { warn: vi.fn() } });
  return { req, res };
}

describe('POST /api/skills/market/suggest-tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockResolvedValue(skill);
  });

  it('uses its own rate-limit bucket, not the publish/scan budget', () => {
    expect(h.rateLimitOpts.map(o => o.bucket)).toEqual(['skill-market-suggest-tags']);
  });

  it.each([
    ['missing', null],
    ["another user's", { ...skill, userId: 'someone-else' }],
  ])('404s for a %s skill', async (_label, found) => {
    h.findById.mockResolvedValue(found);
    const { req, res } = makeReqRes({ skillId: 'skill-1' });
    await expect(handler(req, res)).rejects.toBeInstanceOf(NotFoundError);
    expect(h.getLlm).not.toHaveBeenCalled();
  });

  it('returns no tags for an imported skill without calling the LLM', async () => {
    h.findById.mockResolvedValue({ ...skill, importedFrom: { listingId: 'l-1' } });
    const { req, res } = makeReqRes({ skillId: 'skill-1' });
    await handler(req, res);
    expect(res._getJSONData()).toEqual({ tags: [] });
    expect(h.getLlm).not.toHaveBeenCalled();
  });

  it('returns normalized tags', async () => {
    h.getLlm.mockResolvedValue({ model: 'm', complete: async () => '{"tags":["#Writing","Code Review","bad!"]}' });
    const { req, res } = makeReqRes({ skillId: 'skill-1' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ tags: ['writing', 'code-review'] });
    expect(h.getLlm).toHaveBeenCalledWith(expect.anything(), USER, { maxTokens: 500 });
  });

  it.each([
    ['the LLM wiring throws', () => h.getLlm.mockRejectedValue(new Error('no model'))],
    [
      'the model call throws',
      () => h.getLlm.mockResolvedValue({ model: 'm', complete: async () => Promise.reject(new Error('x')) }),
    ],
  ])('returns 200 { tags: [] } when %s', async (_label, arrange) => {
    arrange();
    const { req, res } = makeReqRes({ skillId: 'skill-1' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ tags: [] });
  });
});
