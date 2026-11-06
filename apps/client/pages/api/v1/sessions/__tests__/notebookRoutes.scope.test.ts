// @vitest-environment node
/**
 * Scope posture of the session files, semantic search and message routes: each contract declares the
 * notebook scopes, the handlers hand them to the API-key chain, and the real gate decision denies a key
 * that holds neither. `baseApi` is stubbed (no DB, no auth chain) but records the options
 * `nextRouteForContract` passes it; the contract adapter itself runs for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  ApiKeyScope,
  deleteSessionMessageContract,
  getSessionMessageContract,
  listSessionFilesContract,
  searchSessionsContract,
  updateSessionMessageContract,
} from '@bike4mind/common';
import { decideScopeGate, parseStagedScopes } from '@bike4mind/server-utils/middlewares/apiKeyScopeGate';

const { baseApiOptions, mockDeleteSessionMessage } = vi.hoisted(() => ({
  baseApiOptions: [] as Array<Record<string, unknown> | undefined>,
  mockDeleteSessionMessage: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options?: Record<string, unknown>) => {
    baseApiOptions.push(options);
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
    chain.put = compose;
    chain.delete = compose;
    return chain;
  },
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(405).json({ error: 'Method not allowed' }),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  fabFileRepository: {},
  questRepository: {},
  sessionRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  fabFilesService: { listFabFilesBySession: vi.fn() },
  sessionService: { deleteSessionMessage: mockDeleteSessionMessage },
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({ getFilesStorage: () => ({}) }));

await import('@pages/api/v1/sessions/[id]/files');
const { default: messageHandler } = await import('@pages/api/v1/sessions/[id]/messages/[messageId]');
const filesOptions = baseApiOptions[0];
const [getOptions, putOptions, deleteOptions] = baseApiOptions.slice(1);

const READ = [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.WRITE_NOTEBOOKS];
const WRITE = [ApiKeyScope.WRITE_NOTEBOOKS];
const NO_STAGING = new Set<string>();

const ROUTES = [
  { name: 'listSessionFiles', contract: listSessionFilesContract, scopes: READ },
  { name: 'searchSessions', contract: searchSessionsContract, scopes: READ },
  { name: 'getSessionMessage', contract: getSessionMessageContract, scopes: READ },
  { name: 'updateSessionMessage', contract: updateSessionMessageContract, scopes: WRITE },
  { name: 'deleteSessionMessage', contract: deleteSessionMessageContract, scopes: WRITE },
];

describe('notebook route scopes', () => {
  it.each(ROUTES)('$name declares its notebook scopes', ({ contract, scopes }) => {
    expect(contract.auth).toBe('apiKeyOrJwt');
    expect(contract.scopes).toEqual(scopes);
  });

  it('hands the contract scopes to the API-key chain', () => {
    expect(filesOptions).toMatchObject({ auth: true, requiredScopes: READ });
    expect(getOptions).toMatchObject({ auth: true, requiredScopes: READ });
    expect(putOptions).toMatchObject({ auth: true, requiredScopes: WRITE });
    expect(deleteOptions).toMatchObject({ auth: true, requiredScopes: WRITE });
  });

  describe.each(ROUTES)('$name gate decision', ({ scopes }) => {
    const required = [...scopes];

    it('denies a key holding neither notebook scope', () => {
      expect(decideScopeGate(required, [ApiKeyScope.AI_GENERATE], NO_STAGING)).toEqual({ outcome: 'deny' });
    });

    it('allows a key holding a required scope', () => {
      expect(decideScopeGate(required, [scopes[0]], NO_STAGING)).toEqual({ outcome: 'allow' });
    });

    it('lets a key through, flagged, only while every required scope is staged', () => {
      const staged = parseStagedScopes('notebooks:read,notebooks:write').staged;
      expect(decideScopeGate(required, [ApiKeyScope.AI_GENERATE], staged)).toMatchObject({ outcome: 'stagedAllow' });
    });
  });

  it('denies a read-only key the write routes', () => {
    expect(decideScopeGate([...WRITE], [ApiKeyScope.READ_NOTEBOOKS], NO_STAGING)).toEqual({ outcome: 'deny' });
  });
});

describe('DELETE /api/v1/sessions/{id}/messages/{messageId}', () => {
  beforeEach(() => vi.clearAllMocks());

  const run = async (method: string) => {
    const { req, res } = createMocks({ method, query: { id: 'sess-1', messageId: 'quest-1' } });
    Object.assign(req, { user: { id: 'owner-1' }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
    await (messageHandler as any)(req, res);
    return res;
  };

  it('soft-deletes through the service as the caller and confirms', async () => {
    const res = await run('DELETE');

    expect(mockDeleteSessionMessage).toHaveBeenCalledWith(
      'owner-1',
      { sessionId: 'sess-1', messageId: 'quest-1' },
      expect.anything()
    );
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ msg: 'Message deleted' });
  });

  it('answers a verb the path does not serve with 405', async () => {
    const res = await run('PATCH');

    expect(res._getStatusCode()).toBe(405);
    expect(mockDeleteSessionMessage).not.toHaveBeenCalled();
  });
});
