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

const mockAudit = vi.fn();
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: (...a: unknown[]) => mockAudit(...a) }));

const modalChanges: Array<{ kind: string; id: string; title: string }> = [];
vi.mock('@client/server/tools/modalOperations', () => ({
  collectModalChanges: async (run: () => Promise<unknown>) => ({ result: await run(), changes: modalChanges }),
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
  beforeEach(() => {
    vi.clearAllMocks();
    modalChanges.length = 0;
    mockAudit.mockResolvedValue(null);
  });

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

  it('records one modal audit entry per modal write the tool performed', async () => {
    modalChanges.push(
      { kind: 'created', id: 'm1', title: 'Welcome' },
      { kind: 'deleted', id: 'm2', title: 'Old banner' }
    );
    mockExecute.mockResolvedValue({ success: true });
    const { run } = call({ body: { tool: 'modal', params: { action: 'process', query: 'q' } } });
    await run();

    expect(mockAudit).toHaveBeenCalledTimes(2);
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'settings.modal.created',
      target: { kind: 'settings', id: 'm1' },
    });
    expect(mockAudit.mock.calls[1][1]).toMatchObject({
      action: 'settings.modal.deleted',
      target: { kind: 'settings', id: 'm2' },
    });
  });

  it('records an admin_tool.executed entry with the tool name for a non-modal tool', async () => {
    mockExecute.mockResolvedValue({ success: true });
    const { run } = call({ body: { tool: 'lookup', params: { action: 'get' } } });
    await run();

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'settings.admin_tool.executed',
      target: { kind: 'settings', id: 'lookup' },
      details: { toolName: 'lookup' },
    });
  });

  it('records nothing when the tool run failed, such as for an unregistered tool name', async () => {
    mockExecute.mockResolvedValue({ success: false, error: 'Tool not found' });
    await call({ body: { tool: 'no_such_tool', params: { action: 'get' } } }).run();

    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('records nothing for the read-only help tool or a modal tool that wrote nothing', async () => {
    mockExecute.mockResolvedValue({ success: true });
    await call({ body: { tool: 'help', params: {} } }).run();
    await call({ body: { tool: 'modal', params: { action: 'list' } } }).run();

    expect(mockAudit).not.toHaveBeenCalled();
  });
});
