import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
const browserSigner = vi.hoisted(() => vi.fn(async () => 'https://objects.example.invalid/file'));
import { createMocks } from 'node-mocks-http';

/**
 * The session lookup inside listFabFilesBySession casts, so it resolves under any hex
 * casing, but the chat-history query behind it hits `sessionId: { type: String }` and does
 * byte equality. The route has to hand the service the canonical lowercase id, or an
 * uppercase request silently returns a partial list.
 */

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
    const used: Mw[] = [];
    const compose =
      (...handlers: Mw[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of [...used, ...handlers]) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = (mw: Mw) => {
      used.push(mw);
      return chain;
    };
    chain.get = compose;
    return chain;
  },
  methodNotAllowedHandler: () => () => undefined,
}));

const listFabFilesBySession = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ fabFilesService: { listFabFilesBySession } }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  fabFileRepository: {},
  questRepository: {},
  sessionRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl: browserSigner }),
}));

const { default: handler } = await import('@pages/api/sessions/[id]/files');

const SESSION_ID = '507f1f77bcf86cd799439011';

const call = (id?: string) => {
  const { req, res } = createMocks({ method: 'GET', query: id === undefined ? {} : { id } });
  Object.assign(req, {
    user: { id: 'user1' },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
  return { res, result: (handler as any)(req, res) as Promise<unknown> };
};

beforeEach(() => {
  vi.clearAllMocks();
  listFabFilesBySession.mockResolvedValue([{ id: 'file1' }]);
});

describe('GET /api/sessions/[id]/files (legacy alias of /api/v1/sessions/{id}/files)', () => {
  it('lists the files for a lowercase-hex session id', async () => {
    const { res, result } = call(SESSION_ID);
    await result;

    expect(res._getStatusCode()).toBe(200);
    expect(listFabFilesBySession).toHaveBeenCalledWith('user1', { sessionId: SESSION_ID }, expect.anything());
  });

  it('passes the canonical lowercase id on for an uppercase-hex session id', async () => {
    const { res, result } = call(SESSION_ID.toUpperCase());
    await result;

    expect(res._getStatusCode()).toBe(200);
    expect(listFabFilesBySession).toHaveBeenCalledWith('user1', { sessionId: SESSION_ID }, expect.anything());
  });

  it('answers 404 for a malformed session id and rejects a missing one', async () => {
    await expect(call('not-a-session-id').result).rejects.toMatchObject({ statusCode: 404 });
    await expect(call().result).rejects.toBeDefined();

    expect(listFabFilesBySession).not.toHaveBeenCalled();
  });
});

it.each([undefined, '', '   ', 'https://objects.example.invalid'])(
  'uses request-local browser signing for collection responses',
  async endpoint => {
    vi.stubEnv('S3_PRESIGN_ENDPOINT', endpoint);
    await call(SESSION_ID).result;
    const adapter = listFabFilesBySession.mock.calls[0][2] as {
      storage: { signedUrlCache?: string; generateSignedUrl: (path: string, expiry: number) => Promise<string | null> };
    };
    expect(adapter.storage.signedUrlCache).toBe(endpoint?.trim() ? 'bypass' : undefined);
    await adapter.storage.generateSignedUrl('owned/report.txt', 600);
    expect(browserSigner).toHaveBeenLastCalledWith('owned/report.txt', 'get', { expiresIn: 600, audience: 'browser' });
  }
);

afterEach(() => vi.unstubAllEnvs());
