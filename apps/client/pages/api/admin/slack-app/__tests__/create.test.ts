// @vitest-environment node
/**
 * `slackData` carries the app's client/signing secrets in `credentials` on a
 * successful `apps.manifest.create` response. The handler must never hand the
 * raw object to the logger - only an allowlisted subset - on either the
 * success or the Slack-side-error branch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = vi.hoisted(() => ({ post: null as null | ((req: any, res: any) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    post: (fn: any) => {
      handlers.post = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const mockCreateOrUpdateWithCredentials = vi.fn();
const mockStoreConfigToken = vi.fn();

vi.mock('@bike4mind/database/infra', () => ({
  slackDevWorkspaceRepository: {
    createOrUpdateWithCredentials: (...a: unknown[]) => mockCreateOrUpdateWithCredentials(...a),
    storeConfigToken: (...a: unknown[]) => mockStoreConfigToken(...a),
  },
}));

import '../create';

const SECRET_FIELDS = ['client_secret', 'signing_secret', 'verification_token'];

const manifest = {
  display_information: { name: 'Test App' },
  features: {},
  oauth_config: { redirect_urls: ['https://example.com/callback'] },
  settings: {},
};

function fire(body: Record<string, unknown>) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withMetadata: vi.fn() };
  const status = vi.fn(() => ({ json: vi.fn() }));
  const res = { status, json: vi.fn() } as any;
  const req = {
    method: 'POST',
    body,
    user: { id: 'admin-1', isAdmin: true },
    logger,
  } as any;
  return { req, res, logger };
}

/** Every logger call, across every level, as a flat list of arguments. */
function allLoggerArgs(logger: { info: any; warn: any; error: any }): unknown[] {
  return [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].flat();
}

describe('POST /api/admin/slack-app/create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('never hands a secret to the logger on a successful create', async () => {
    (global.fetch as any).mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          app_id: 'A123',
          credentials: {
            client_id: 'id-1',
            client_secret: 'should-not-leak-secret',
            signing_secret: 'should-not-leak-signing',
            verification_token: 'should-not-leak-verification',
          },
        }),
    });
    mockCreateOrUpdateWithCredentials.mockResolvedValue({ id: 'ws-1' });
    mockStoreConfigToken.mockResolvedValue(undefined);

    const { req, res, logger } = fire({ manifest, configToken: 'xoxe-config-token' });
    await handlers.post!(req, res);

    expect(res.status).toHaveBeenCalledWith(200);

    const serialized = JSON.stringify(allLoggerArgs(logger));
    for (const field of SECRET_FIELDS) expect(serialized).not.toContain(field);
  });

  it('logs only an allowlisted subset - not the raw response - on a Slack-side error', async () => {
    (global.fetch as any).mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: false,
          error: 'internal_error',
          errors: ['manifest field invalid'],
          // Not part of Slack's real error shape, but present here to prove the
          // handler never forwards the raw object wholesale even if it were.
          credentials: { client_secret: 'should-not-leak-secret' },
        }),
    });

    const { req, res, logger } = fire({ manifest, configToken: 'xoxe-config-token' });
    await expect(handlers.post!(req, res)).rejects.toThrow();

    expect(logger.error).toHaveBeenCalledWith('Slack API error:', {
      error: 'internal_error',
      errors: ['manifest field invalid'],
    });

    const serialized = JSON.stringify(allLoggerArgs(logger));
    for (const field of SECRET_FIELDS) expect(serialized).not.toContain(field);
  });
});
