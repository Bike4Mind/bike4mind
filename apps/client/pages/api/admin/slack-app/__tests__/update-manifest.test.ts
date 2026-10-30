// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Route = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  findByIdWithConfigToken: vi.fn(),
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
  slackDevWorkspaceRepository: { findByIdWithConfigToken: h.findByIdWithConfigToken },
}));
vi.mock('@bike4mind/slack', () => ({
  mergeManifest: (manifest: unknown) => manifest,
  extractBaseUrl: () => 'https://example.com',
  isSlackUserValidationError: () => false,
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../update-manifest';

const CONFIG_TOKEN = 'xoxe-config-token';

const update = async () => {
  const { req, res } = createMocks({ method: 'POST', body: { workspaceId: 'ws-1' } });
  Object.assign(req, {
    user: { id: 'admin-1', isAdmin: true },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  await (handler as unknown as Route)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true, manifest: { display_information: {} } }) })
  );
  h.findByIdWithConfigToken.mockResolvedValue({
    id: 'ws-1',
    name: 'Acme',
    slackAppId: 'A123',
    appConfigurationToken: CONFIG_TOKEN,
  });
  h.audit.mockResolvedValue(null);
});

describe('POST /api/admin/slack-app/update-manifest admin audit', () => {
  it('records a best-effort manifest_updated entry after Slack accepts the update', async () => {
    const { req, res } = await update();

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'integration.slack_app.manifest_updated',
      target: { kind: 'settings', id: 'ws-1', displayName: 'Acme' },
      details: { appId: 'A123' },
    });
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain(CONFIG_TOKEN);
  });

  it('does not audit when Slack rejects the update', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ json: () => Promise.resolve({ ok: true, manifest: {} }) } as Response)
      .mockResolvedValueOnce({ json: () => Promise.resolve({ ok: false, error: 'invalid_manifest' }) } as Response);

    await expect(update()).rejects.toThrow('invalid_manifest');
    expect(h.audit).not.toHaveBeenCalled();
  });
});
