import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

// Middleware stripped so the handler body runs directly (same pattern as
// __tests__/provider-invoices.test.ts). The chain object doubles as the exported
// handler and dispatches on req.method. Captures the config so a test can assert
// requiredScopes: the scope gate lives in apiKeyAuth (real middleware, not
// exercised here), so asserting the handler is registered with it is the only
// guard available at this level.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const chain = async (req: { method: string }, res: unknown) => handlers[req.method](req, res);
    chain.use = () => chain;
    chain.post = (fn: (typeof handlers)[string]) => {
      handlers.POST = fn;
      return chain;
    };
    chain._config = config;
    return chain;
  },
}));

const mockExecute = vi.fn();
vi.mock('@client/server/tools/adminToolsServer', () => ({
  initializeServerAdminTools: vi.fn(),
  getServerAdminToolService: () => ({ execute: (...a: unknown[]) => mockExecute(...a) }),
}));

import handler from '../execute';

function call(options: { isAdmin?: boolean; body?: object }) {
  const { req, res } = createMocks({ method: 'POST', body: options.body });
  (req as unknown as { user: { isAdmin: boolean; id: string } }).user = {
    isAdmin: options.isAdmin ?? true,
    id: 'admin-1',
  };
  return { res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('POST /api/admin/tools/execute', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires the ADMIN scope so an under-scoped admin-owned key is 403d by apiKeyAuth', () => {
    const config = (handler as unknown as { _config?: { requiredScopes?: string[] } })._config;
    expect(config?.requiredScopes).toEqual([ApiKeyScope.ADMIN]);
  });

  it('rejects non-admin callers', async () => {
    const { run } = call({ isAdmin: false, body: { tool: 'x' } });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('executes the requested tool for an admin', async () => {
    mockExecute.mockResolvedValue({ ok: true });
    const { res, run } = call({ body: { tool: 'lookup', params: { action: 'get', query: 'q' } } });
    await run();
    expect(mockExecute).toHaveBeenCalledWith(
      'lookup',
      expect.objectContaining({ user: expect.objectContaining({ id: 'admin-1' }) }),
      expect.objectContaining({ action: 'get', query: 'q' })
    );
    expect(res._getJSONData()).toEqual({ ok: true });
  });
});
