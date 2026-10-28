// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Route = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  deactivate: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => {
    const routes: Record<string, Route> = {};
    const chain = Object.assign((req: unknown, res: unknown) => routes[(req as { method: string }).method](req, res), {
      get: (fn: Route) => ((routes.GET = fn), chain),
      patch: (fn: Route) => ((routes.PATCH = fn), chain),
    });
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  slackDevWorkspaceRepository: { deactivate: h.deactivate, findAllActive: vi.fn() },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn() } }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../slack-workspaces';

const deactivate = async () => {
  const { req, res } = createMocks({ method: 'PATCH', body: { workspaceId: 'ws-1', action: 'deactivate' } });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await (handler as unknown as Route)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
});

describe('PATCH /api/admin/slack-workspaces admin audit', () => {
  it('records a strict deactivated entry after the deactivate', async () => {
    h.deactivate.mockResolvedValue({
      id: 'ws-1',
      name: 'Acme',
      slackTeamId: 'T1',
      slackAppId: 'A123',
      isActive: false,
    });

    const { req, res } = await deactivate();

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'integration.slack_workspace.deactivated',
      target: { kind: 'settings', id: 'ws-1', displayName: 'Acme' },
      details: { slackTeamId: 'T1' },
    });
    expect(h.deactivate.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('fails the request when the audit write rejects', async () => {
    h.deactivate.mockResolvedValue({
      id: 'ws-1',
      name: 'Acme',
      slackTeamId: 'T1',
      slackAppId: 'A123',
      isActive: false,
    });
    h.audit.mockRejectedValue(new Error('audit down'));

    await expect(deactivate()).rejects.toThrow('audit down');
  });

  it('does not audit when the workspace does not exist', async () => {
    h.deactivate.mockResolvedValue(null);

    await expect(deactivate()).rejects.toThrow('Workspace not found');
    expect(h.audit).not.toHaveBeenCalled();
  });
});
