// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Route = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  findByIdWithConfigToken: vi.fn(),
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
        get: (fn: Route) => ((routes.GET = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database/infra', () => ({
  slackDevWorkspaceRepository: { findByIdWithConfigToken: h.findByIdWithConfigToken },
}));
vi.mock('@bike4mind/slack', () => ({
  compareManifests: () => ({ isUpToDate: true, differences: [] }),
  extractBaseUrl: () => 'https://example.com',
}));

import handler from '../manifest-status';

const slackResponds = (body: Record<string, unknown>) =>
  vi.mocked(fetch).mockResolvedValue({ json: () => Promise.resolve(body) } as Response);

const checkStatus = async () => {
  const { req, res } = createMocks({ method: 'GET', query: { workspaceId: 'ws-1' } });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  Object.assign(req, { user: { id: 'admin-1', isAdmin: true }, logger });
  const thrown: unknown = await Promise.resolve((handler as unknown as Route)(req, res)).then(
    () => undefined,
    (error: unknown) => error
  );
  return { res, logger, thrown };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  h.findByIdWithConfigToken.mockResolvedValue({
    id: 'ws-1',
    slackAppId: 'A123',
    appConfigurationToken: 'xoxe-config-token',
  });
});

describe('GET /api/admin/slack-app/manifest-status token rejection', () => {
  it('reports an expired stored token as missing_token with a reconnect message, logged at warn', async () => {
    slackResponds({ ok: false, error: 'token_expired' });

    const { res, logger, thrown } = await checkStatus();

    expect(thrown).toBeUndefined();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      status: 'missing_token',
      message: expect.stringContaining('Reconnect with a fresh app configuration token'),
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('config token'), {
      error: 'token_expired',
      workspaceId: 'ws-1',
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('still logs an unexpected Slack error at error and answers 400', async () => {
    slackResponds({ ok: false, error: 'internal_error' });

    const { logger, thrown } = await checkStatus();

    expect(thrown).toMatchObject({ statusCode: 400, message: 'internal_error' });
    expect(logger.error).toHaveBeenCalledWith('Failed to export manifest from Slack', {
      error: 'internal_error',
      workspaceId: 'ws-1',
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reports up_to_date when Slack accepts the token', async () => {
    slackResponds({ ok: true, manifest: { display_information: {} } });

    const { res, logger } = await checkStatus();

    expect(res._getJSONData()).toEqual({ status: 'up_to_date', differences: [] });
    expect(logger.error).not.toHaveBeenCalled();
  });
});
