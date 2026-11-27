import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;
interface BaseApiChain {
  get: (...fns: Handler[]) => BaseApiChain;
  post: (...fns: Handler[]) => BaseApiChain;
  put: (...fns: Handler[]) => BaseApiChain;
}

const registry = vi.hoisted(() => ({
  handlers: {} as Partial<Record<string, (req: unknown, res: unknown) => unknown>>,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: BaseApiChain = {
      get: (...fns) => ((registry.handlers.GET = fns[fns.length - 1]), chain),
      post: (...fns) => ((registry.handlers.POST = fns[fns.length - 1]), chain),
      put: (...fns) => ((registry.handlers.PUT = fns[fns.length - 1]), chain),
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: Handler) => fn,
}));

// A prompt as the repository and the model return it: the declared fields plus one that is not.
const UNDECLARED = 'internal-only-value';
const prompt = {
  id: 'pr1',
  type: 'system',
  name: 'greeting',
  promptText: 'hello',
  tags: ['a'],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  lastUpdated: new Date('2026-01-02T00:00:00Z'),
  internalNote: UNDECLARED,
};

const promptService = vi.hoisted(() => ({
  getPrompt: vi.fn(),
  listPromptByTags: vi.fn(),
  listPromptsByTypes: vi.fn(),
  listPromptByName: vi.fn(),
  createPrompt: vi.fn(),
  updatePrompt: vi.fn(),
}));
const promptModel = vi.hoisted(() => ({ find: vi.fn(), findOne: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ promptService }));
vi.mock('@bike4mind/database', () => ({
  Prompt: promptModel,
  promptRepository: {},
}));

// Hydrated mongoose documents serialize through toJSON, which res.json used to call implicitly.
const hydrated = { toJSON: () => prompt };

const run = async (
  load: () => Promise<unknown>,
  method: 'GET' | 'POST' | 'PUT',
  { query, body }: { query?: Record<string, unknown>; body?: Record<string, unknown> } = {}
) => {
  await load();
  const { req, res } = createMocks({ method, query: query as Record<string, string>, body });
  (req as unknown as { user: { id: string } }).user = { id: 'u1' };
  (req as unknown as { ability: { can: () => boolean } }).ability = { can: () => true };
  await registry.handlers[method]!(req, res);
  return res;
};

const expectStripped = (json: Record<string, unknown> | Record<string, unknown>[]) => {
  const entity = Array.isArray(json) ? json[0] : json;
  expect(entity.id).toBe('pr1');
  expect(entity).toHaveProperty('lastUpdated');
  expect(entity).not.toHaveProperty('internalNote');
  expect(JSON.stringify(json)).not.toContain(UNDECLARED);
};

describe('prompt routes - response schemas strip undeclared fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Routes register their handlers at import time, so each test needs a fresh import.
    vi.resetModules();
    registry.handlers = {};
  });

  it('GET /api/prompts?id', async () => {
    promptService.getPrompt.mockResolvedValue(prompt);
    const res = await run(() => import('@pages/api/prompts/index'), 'GET', { query: { id: 'pr1' } });
    expectStripped(res._getJSONData());
  });

  it('GET /api/prompts?tags', async () => {
    promptService.listPromptByTags.mockResolvedValue([prompt]);
    const res = await run(() => import('@pages/api/prompts/index'), 'GET', { query: { tags: ['a'] } });
    expectStripped(res._getJSONData());
  });

  it('GET /api/prompts?type', async () => {
    promptService.listPromptsByTypes.mockResolvedValue([prompt]);
    const res = await run(() => import('@pages/api/prompts/index'), 'GET', { query: { type: 'system' } });
    expectStripped(res._getJSONData());
  });

  it('GET /api/prompts?name', async () => {
    promptService.listPromptByName.mockResolvedValue([prompt]);
    const res = await run(() => import('@pages/api/prompts/index'), 'GET', { query: { name: 'greeting' } });
    expectStripped(res._getJSONData());
  });

  it('GET /api/prompts (all)', async () => {
    promptModel.find.mockResolvedValue([hydrated]);
    const res = await run(() => import('@pages/api/prompts/index'), 'GET');
    expectStripped(res._getJSONData());
  });

  it('POST /api/prompts', async () => {
    promptService.createPrompt.mockResolvedValue(prompt);
    const res = await run(() => import('@pages/api/prompts/index'), 'POST', {
      body: { type: 'system', name: 'greeting', promptText: 'hello' },
    });
    expect(res._getStatusCode()).toBe(201);
    expectStripped(res._getJSONData());
  });

  it('PUT /api/prompts/[id]/update', async () => {
    promptService.updatePrompt.mockResolvedValue(prompt);
    const res = await run(() => import('@pages/api/prompts/[id]/update'), 'PUT', {
      query: { id: 'pr1' },
      body: { promptText: 'hello' },
    });
    expectStripped(res._getJSONData());
  });

  it('GET /api/prompts/get-by-name', async () => {
    promptModel.findOne.mockResolvedValue(hydrated);
    const res = await run(() => import('@pages/api/prompts/get-by-name'), 'GET', { query: { name: 'greeting' } });
    expectStripped(res._getJSONData());
  });

  it('GET /api/prompts/get-by-name responds null when no prompt matches', async () => {
    promptModel.findOne.mockResolvedValue(null);
    const res = await run(() => import('@pages/api/prompts/get-by-name'), 'GET', { query: { name: 'missing' } });
    expect(res._getJSONData()).toBeNull();
  });
});
