// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Route = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  storeConfigToken: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, Route> = {};
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain: Record<string, unknown> & Route = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return routes[(req as { method: string }).method](req, res);
      },
      {
        use: (middleware: (req: unknown, res: unknown, next: () => void) => void) => (
          middlewares.push(middleware),
          chain
        ),
        post: (fn: Route) => ((routes.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database/infra', () => ({
  slackDevWorkspaceRepository: { findById: h.findById, storeConfigToken: h.storeConfigToken },
}));
vi.mock('@bike4mind/database', () => ({ withTransaction: (fn: () => Promise<unknown>) => fn() }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../reconnect';

const CONFIG_TOKEN = 'xoxe-config-token';

const reconnect = async () => {
  const { req, res } = createMocks({ method: 'POST', body: { workspaceId: 'ws-1', configToken: CONFIG_TOKEN } });
  Object.assign(req, {
    user: { id: 'admin-1', isAdmin: true },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  await (handler as unknown as Route)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true, manifest: {} }) }));
  h.findById.mockResolvedValue({ id: 'ws-1', name: 'Acme', slackAppId: 'A123' });
  h.storeConfigToken.mockResolvedValue({ id: 'ws-1' });
  h.audit.mockResolvedValue(null);
});

describe('POST /api/admin/slack-app/reconnect admin audit', () => {
  it('records a strict reconnected entry after storing the token', async () => {
    const { req, res } = await reconnect();

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'integration.slack_app.reconnected',
      target: { kind: 'settings', id: 'ws-1', displayName: 'Acme' },
      details: { appId: 'A123' },
    });
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain(CONFIG_TOKEN);
    expect(h.storeConfigToken.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('does not report success when the audit write rejects', async () => {
    h.audit.mockRejectedValue(new Error('audit down'));

    await expect(reconnect()).rejects.toThrow('audit down');
  });
});
