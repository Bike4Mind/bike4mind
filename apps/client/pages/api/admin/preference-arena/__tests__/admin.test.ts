import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Handler = (req: unknown, res: unknown) => unknown;
type Middleware = (req: unknown, res: unknown, next: () => void) => void;

const captured = vi.hoisted(() => ({ middlewares: [] as Middleware[], handlers: {} as Record<string, Handler> }));
const { mockImport, mockStats } = vi.hoisted(() => ({ mockImport: vi.fn(), mockStats: vi.fn() }));

// Keeps the real adminApi permission gate: it runs as a captured middleware ahead of the handler.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      use(fn: Middleware) {
        captured.middlewares.push(fn);
        return this;
      },
      get(fn: Handler) {
        captured.handlers.GET = fn;
        return this;
      },
      post(fn: Handler) {
        captured.handlers.POST = fn;
        return this;
      },
    };
    return chain;
  },
}));
vi.mock('@server/preferenceArena', () => ({
  getArenaService: () => ({ importPairs: mockImport, getArenaStats: mockStats }),
}));

import { config } from '../pairs/index';

const run = async (method: 'GET' | 'POST', user: Record<string, unknown>, body?: unknown) => {
  const { req, res } = createMocks({ method, body: body as never });
  Object.assign(req, { user, logger: { error: vi.fn() } });
  for (const middleware of captured.middlewares) middleware(req, res, () => undefined);
  await captured.handlers[method](req, res);
  return res;
};

const validPair = {
  prompt: 'p',
  taskType: 'code',
  source: 'synthetic',
  answers: [
    { modelId: 'm1', text: 'a' },
    { modelId: 'm2', text: 'b' },
  ],
};

describe('admin arena pairs route', () => {
  beforeEach(() => {
    mockImport.mockReset();
  });

  it('rejects a non-admin before the handler runs', async () => {
    await expect(run('POST', { id: 'u1', isAdmin: false }, { pairs: [validPair] })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('rejects an invalid import body with 400', async () => {
    await expect(run('POST', { id: 'admin1', isAdmin: true }, { pairs: [] })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('accepts 500 pairs and rejects 501 with 400', async () => {
    mockImport.mockResolvedValue(500);
    await run('POST', { id: 'admin1', isAdmin: true }, { pairs: Array(500).fill(validPair) });
    expect(mockImport).toHaveBeenCalledTimes(1);
    await expect(
      run('POST', { id: 'admin1', isAdmin: true }, { pairs: Array(501).fill(validPair) })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockImport).toHaveBeenCalledTimes(1);
  });

  it('raises the body limit to fit a full 500-pair import', () => {
    expect(config.api.bodyParser.sizeLimit).toBe('4mb');
  });

  it('imports pairs for an admin', async () => {
    mockImport.mockResolvedValue(1);
    const res = await run('POST', { id: 'admin1', isAdmin: true }, { pairs: [validPair] });
    expect(mockImport).toHaveBeenCalledWith('admin1', [validPair]);
    expect(res._getJSONData()).toEqual({ inserted: 1 });
  });
});
