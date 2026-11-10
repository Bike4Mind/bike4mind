// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Route = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({ listStuck: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const routes: Record<string, Route> = {};
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return routes[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
        get: (fn: Route) => ((routes.GET = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  agentExecutionRepository: { listStuck: h.listStuck },
  ACTIVE_AGENT_EXECUTION_STATUSES: ['running', 'awaiting_permission', 'awaiting_subagent', 'awaiting_dag_children'],
}));

import handler from '../stuck';

beforeEach(() => {
  vi.clearAllMocks();
  h.listStuck.mockResolvedValue([]);
});

describe('GET /api/admin/agent-executions/stuck delegated access', () => {
  it.each(['settings:manage', 'support:read'])('lets a %s-only delegate list stuck executions', async permission => {
    const { req, res } = createMocks({ method: 'GET' });
    (req as unknown as Record<string, unknown>).user = { id: 'u1', isAdmin: false, adminPermissions: [permission] };

    await (handler as unknown as Route)(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(h.listStuck).toHaveBeenCalledTimes(1);
  });

  it('rejects a user with neither permission', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    (req as unknown as Record<string, unknown>).user = { id: 'u1', isAdmin: false, adminPermissions: ['users:read'] };

    await expect((handler as unknown as Route)(req, res)).rejects.toThrow('Missing permission');
    expect(h.listStuck).not.toHaveBeenCalled();
  });
});
