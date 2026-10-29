// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  markAbandoned: vi.fn(),
  markQuestSettlementFailed: vi.fn(),
  settleStrandedQuests: vi.fn(),
}));

type Route = (req: unknown, res: unknown) => unknown;

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
        post: (fn: Route) => ((routes.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  agentExecutionRepository: {
    markAbandoned: h.markAbandoned,
    markQuestSettlementFailed: h.markQuestSettlementFailed,
  },
}));
vi.mock('@bike4mind/server-utils/utils/settleStrandedQuests', () => ({ settleStrandedQuests: h.settleStrandedQuests }));
vi.mock('@bike4mind/database/social', () => ({ Connection: { findByUserId: vi.fn().mockResolvedValue([]) } }));
vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: vi.fn(),
  PostToConnectionCommand: vi.fn(),
}));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://example.test' } } }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../cleanup';

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.markAbandoned.mockResolvedValue([{ id: 'e1', userId: 'u1' }]);
  h.settleStrandedQuests.mockResolvedValue({ settled: 1, failedExecutionIds: [] });
});

describe('POST /api/admin/agent-executions/cleanup admin audit', () => {
  it('records ops.agent_executions.cleaned_up with the marked count and swept ids', async () => {
    const { req, res } = createMocks({ method: 'POST', body: { executionIds: ['e1', 'e2'] } });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };

    await (handler as unknown as Route)(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'ops.agent_executions.cleaned_up',
      target: { kind: 'system', id: 'agent-executions-cleanup' },
      details: { requested: 2, marked: 1, executionIds: ['e1'] },
    });
    expect(h.markAbandoned.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });
});
