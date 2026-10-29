// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;
type Middleware = (req: unknown, res: unknown, next: () => void) => void;

// baseApi: capture the real adminApi gate and the DELETE handler so both run in order. The
// route chains .use(...).get(...).put(...).delete(...), so every method must return `this`.
const captured = vi.hoisted(() => ({
  middlewares: [] as Middleware[],
  deleteHandler: undefined as HandlerFn | undefined,
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      use(fn: Middleware) {
        captured.middlewares.push(fn);
        return this;
      },
      get() {
        return this;
      },
      put() {
        return this;
      },
      delete(fn: HandlerFn) {
        captured.deleteHandler = fn;
        return this;
      },
    };
    return chain;
  },
}));

vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

const mockFindByPromptId = vi.fn();
const mockDeletePrompt = vi.fn();
vi.mock('@bike4mind/database', () => ({
  systemPromptRepository: {
    findByPromptId: (...args: unknown[]) => mockFindByPromptId(...args),
    deletePrompt: (...args: unknown[]) => mockDeletePrompt(...args),
  },
}));

const mockGetDefaults = vi.fn();
vi.mock('@server/utils/systemPrompts/defaults', () => ({
  getDefaultSystemPrompts: () => mockGetDefaults(),
}));

import '../[promptId]';

async function callDelete(req: unknown, res: unknown) {
  for (const middleware of captured.middlewares) middleware(req, res, () => undefined);
  return captured.deleteHandler!(req, res);
}

function makeReq(promptId: string, isAdmin = true) {
  const { req, res } = createMocks({ method: 'DELETE' });
  (req as Record<string, unknown>).user = { id: 'admin-1', name: 'Admin One', isAdmin };
  (req as Record<string, unknown>).query = { promptId };
  return { req: req as Parameters<HandlerFn>[0], res };
}

describe('DELETE /api/admin/system-prompts/[promptId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes a DB-only prompt and preserves its history', async () => {
    mockGetDefaults.mockReturnValue([{ promptId: 'opti_optimizer' }]);
    mockFindByPromptId.mockResolvedValue({ promptId: 'probe_row', name: 'Probe Row', version: 2 });
    mockDeletePrompt.mockResolvedValue({ deleted: true, historyPreserved: true });

    const { req, res } = makeReq('probe_row');
    await callDelete(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockDeletePrompt).toHaveBeenCalledWith('probe_row', 'admin-1', 'Admin One');
    const body = res._getJSONData();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ promptId: 'probe_row', deletedVersion: 2, historyPreserved: true });
  });

  it('refuses to delete a prompt that has a code default, pointing at reset instead', async () => {
    mockGetDefaults.mockReturnValue([{ promptId: 'opti_optimizer' }]);

    const { req, res } = makeReq('opti_optimizer');
    await callDelete(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().message).toMatch(/reset/i);
    expect(mockDeletePrompt).not.toHaveBeenCalled();
    // Must not even look the row up: a code default is disqualifying on its own.
    expect(mockFindByPromptId).not.toHaveBeenCalled();
  });

  it('404s when there is no DB row and no code default', async () => {
    mockGetDefaults.mockReturnValue([]);
    mockFindByPromptId.mockResolvedValue(null);

    const { req, res } = makeReq('never_existed');
    await callDelete(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(mockDeletePrompt).not.toHaveBeenCalled();
  });

  it('rejects non-admin callers', async () => {
    mockGetDefaults.mockReturnValue([]);

    const { req, res } = makeReq('probe_row', false);
    await expect(callDelete(req, res)).rejects.toThrow(/missing permission/i);
    expect(mockDeletePrompt).not.toHaveBeenCalled();
  });
});
