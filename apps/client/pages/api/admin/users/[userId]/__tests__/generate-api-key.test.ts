import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Three concerns on the admin key-minting endpoint:
 *
 * 1. Scope allowlist - the endpoint may mint overwatch-ingest:write (admin-provisioned) but not
 *    admin:* or cc-bridge:connect, which still have no minting path. All standard user scopes
 *    remain mintable here.
 * 2. Lake-binding screen - `preauthorizedLakeIds` is a CEILING on what the key may admit, never a
 *    grant, so an id the TARGET user cannot manage is inert rather than an escalation. The screen
 *    exists to stop that silent no-op being persisted, and to canonicalize the ids: the containment
 *    check in sessions/create is a byte comparison, so an uppercase-hex id would never match.
 * 3. Canonical target id - the same byte-comparison hazard one field over; see the third describe.
 */

const LAKE_A = '0123456789abcdef01234567';
const LAKE_A_UPPER = '0123456789ABCDEF01234567';
const LAKE_B = '89abcdef0123456789abcdef';

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = {
      use: () => chain,
      post: (fn: any) => {
        mockRefs.postHandler = fn;
        return chain;
      },
    };
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: any) => fn,
}));

vi.mock('@server/middlewares/csrfProtection', () => ({
  csrfProtection: () => vi.fn(),
}));

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

vi.mock('@bike4mind/utils', () => ({
  BadRequestError: class BadRequestError extends Error {},
}));

const mockUserFind = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'target-user', username: 'targetUser' }));
const mockLakeFind = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockUserFind(...a) },
  dataLakeRepository: { findById: (...a: unknown[]) => mockLakeFind(...a) },
  dataLakeAccessGrantRepository: { listActiveByLakes: vi.fn().mockResolvedValue([]) },
  organizationRepository: { findIdsWithAdminRights: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@bike4mind/database/auth', () => ({
  userApiKeyRepository: {},
}));

const mockCreateKey = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ id: 'k1', name: 'key', scopes: ['notebooks:read'] })
);
const mockFilterManaged = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({
  userApiKeyService: { createUserApiKey: (...a: unknown[]) => mockCreateKey(...a) },
  dataLakeService: { filterStillManagedLakes: (...a: unknown[]) => mockFilterManaged(...a) },
}));

const mockLogEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/analyticsLog', () => ({
  logEvent: (...a: unknown[]) => mockLogEvent(...a),
}));

import '../generate-api-key';
import { ForbiddenError } from '@server/utils/errors';
import { BadRequestError } from '@bike4mind/utils';

const activeLake = (id: string) => ({ id, status: 'active', createdByUserId: 'someone', name: id, slug: id });

function post(body: unknown, opts: { isAdmin?: boolean; userId?: string } = {}) {
  const { req, res } = createMocks({
    method: 'POST',
    query: { userId: opts.userId ?? 'target-user' },
    body,
  });
  (req as any).user = {
    id: 'caller',
    isAdmin: opts.isAdmin ?? true,
    username: 'admin-user',
  };
  (req as any).ability = {};
  (req as any).ip = '127.0.0.1';
  (req as any).headers = { 'user-agent': 'test' };
  (req as any).logger = { info: vi.fn(), warn: vi.fn() };
  return { req, res };
}

describe('POST /api/admin/users/:userId/generate-api-key - scope allowlist guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFind.mockResolvedValue({ id: 'target-user', username: 'targetUser' });
    mockCreateKey.mockResolvedValue({ id: 'k1', name: 'key', scopes: ['notebooks:read'] });
    mockLogEvent.mockResolvedValue(undefined);
  });

  it('rejects non-admin callers with ForbiddenError before touching the service', async () => {
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'] }, { isAdmin: false });
    await expect(mockRefs.postHandler!(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('rejects admin:* even from an admin caller with Scope not allowed', async () => {
    const { req, res } = post({ name: 'test', scopes: ['admin:*'] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/Scope not allowed/i);
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('rejects admin:* even when mixed with valid scopes', async () => {
    const { req, res } = post({ name: 'test', scopes: ['notebooks:read', 'admin:*'] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/Scope not allowed/i);
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('rejects cc-bridge:connect with Scope not allowed', async () => {
    const { req, res } = post({ name: 'bridge', scopes: ['cc-bridge:connect'] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/Scope not allowed/i);
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('allows overwatch-ingest:write (admin-provisioned scope) and calls the service', async () => {
    const { req, res } = post({ name: 'ingest', scopes: ['overwatch-ingest:write'] });
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(201);
    expect(mockCreateKey).toHaveBeenCalledWith(
      'target-user',
      expect.objectContaining({ scopes: ['overwatch-ingest:write'] }),
      expect.anything()
    );
  });

  it('allows standard user scopes (notebooks:read) through the admin endpoint', async () => {
    const { req, res } = post({ name: 'plain', scopes: ['notebooks:read'] });
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(201);
    expect(mockCreateKey).toHaveBeenCalled();
  });

  it('rejects with BadRequestError when the target user does not exist', async () => {
    mockUserFind.mockResolvedValueOnce(null);
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('omits preauthorizedLakeIds from the service call when not given, without reading any lake', async () => {
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'] });
    await mockRefs.postHandler!(req, res);
    expect(mockCreateKey).toHaveBeenCalledWith(
      'target-user',
      expect.objectContaining({ preauthorizedLakeIds: undefined }),
      expect.anything()
    );
    expect(mockLakeFind).not.toHaveBeenCalled();
    expect(mockFilterManaged).not.toHaveBeenCalled();
  });

  it('treats an empty preauthorizedLakeIds array as no binding at all', async () => {
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: [] });
    await mockRefs.postHandler!(req, res);
    expect(mockCreateKey).toHaveBeenCalledWith(
      'target-user',
      expect.objectContaining({ preauthorizedLakeIds: undefined }),
      expect.anything()
    );
    expect(mockLakeFind).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/users/:userId/generate-api-key - preauthorizedLakeIds screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFind.mockResolvedValue({ id: 'target-user', username: 'targetUser' });
    mockCreateKey.mockResolvedValue({ id: 'k1', name: 'key', scopes: ['notebooks:read'] });
    mockLogEvent.mockResolvedValue(undefined);
    mockLakeFind.mockImplementation(async (id: string) => activeLake(id));
    // Default: the target manages everything handed to the screen.
    mockFilterManaged.mockImplementation(async (lakes: { id: string }[]) => lakes);
  });

  it('forwards a screened, target-managed binding to the service', async () => {
    const { req, res } = post({
      name: 'key',
      scopes: ['notebooks:read'],
      preauthorizedLakeIds: [LAKE_A, LAKE_B],
    });
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(201);
    expect(mockCreateKey).toHaveBeenCalledWith(
      'target-user',
      expect.objectContaining({ preauthorizedLakeIds: [LAKE_A, LAKE_B] }),
      expect.anything()
    );
  });

  it('screens against the TARGET user, not the admin caller', async () => {
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: [LAKE_A] });
    await mockRefs.postHandler!(req, res);
    const [lakes, actorId] = mockFilterManaged.mock.calls[0];
    expect(lakes).toEqual([expect.objectContaining({ id: LAKE_A })]);
    expect(actorId).toBe('target-user');
  });

  it('wires both manage rungs into the re-check adapter', async () => {
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: [LAKE_A] });
    await mockRefs.postHandler!(req, res);
    // Both adapter members are OPTIONAL on ManageRecheckAdapter and both degrade CLOSED, so a
    // renamed or dropped key would silently deny legitimate maintainers with every other
    // assertion in this file still green. Pin the shape, not just that something was passed.
    const adapter = mockFilterManaged.mock.calls[0][2];
    expect(typeof adapter.dataLakeAccessGrants?.listActiveByLakes).toBe('function');
    expect(typeof adapter.organizations?.findIdsWithAdminRights).toBe('function');
  });

  it('screens against the canonical target id, not the raw URL segment', async () => {
    // findById casts to ObjectId so an uppercase-hex segment resolves the user, but every manage
    // rung compares the actor id byte-wise against a `type: String` field.
    mockUserFind.mockResolvedValue({ id: 'target-user', username: 'targetUser' });
    const { req, res } = post(
      { name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: [LAKE_A] },
      { userId: 'TARGET-USER' }
    );
    await mockRefs.postHandler!(req, res);
    expect(mockFilterManaged.mock.calls[0][1]).toBe('target-user');
  });

  it('lowercases an uppercase-hex id, which would otherwise never match at session-create', async () => {
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: [LAKE_A_UPPER] });
    await mockRefs.postHandler!(req, res);
    expect(mockLakeFind).toHaveBeenCalledWith(LAKE_A);
    expect(mockCreateKey).toHaveBeenCalledWith(
      'target-user',
      expect.objectContaining({ preauthorizedLakeIds: [LAKE_A] }),
      expect.anything()
    );
  });

  it('dedupes ids that differ only in case', async () => {
    const { req, res } = post({
      name: 'key',
      scopes: ['notebooks:read'],
      preauthorizedLakeIds: [LAKE_A, LAKE_A_UPPER, LAKE_A],
    });
    await mockRefs.postHandler!(req, res);
    expect(mockLakeFind).toHaveBeenCalledTimes(1);
    expect(mockCreateKey).toHaveBeenCalledWith(
      'target-user',
      expect.objectContaining({ preauthorizedLakeIds: [LAKE_A] }),
      expect.anything()
    );
  });

  it('rejects a malformed lake id without reading a lake or minting', async () => {
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: ['lake1'] });
    // BadRequestError specifically, not any throw: a plain Error would be mapped to a 500 by the
    // error handler and every message assertion in this file would still pass.
    await expect(mockRefs.postHandler!(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(mockLakeFind).not.toHaveBeenCalled();
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('rejects a non-string entry', async () => {
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: [{ id: LAKE_A }] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/Invalid data lake id/i);
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('rejects a non-array preauthorizedLakeIds', async () => {
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: LAKE_A });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/must be an array/i);
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('rejects more ids than the service would accept, before spending a read per id', async () => {
    const many = Array.from({ length: 26 }, (_, i) => `0123456789abcdef${String(i).padStart(8, '0')}`);
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: many });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/At most 25/i);
    expect(mockLakeFind).not.toHaveBeenCalled();
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('caps the RAW array, so a flood of duplicates cannot drive the dedupe loop', async () => {
    // The cap has to sit before the dedupe, not after: the dedupe is itself work proportional to
    // the input, so capping the deduped result would leave the loop unbounded.
    const flood = Array.from({ length: 5000 }, (_, i) => `0123456789abcdef${String(i).padStart(8, '0')}`);
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: flood });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/At most 25/i);
    expect(mockLakeFind).not.toHaveBeenCalled();
  });

  it('rejects an id that names no lake, listing it', async () => {
    mockLakeFind.mockImplementation(async (id: string) => (id === LAKE_A ? activeLake(id) : null));
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: [LAKE_A, LAKE_B] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(new RegExp(`Data lake not found: ${LAKE_B}`));
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('distinguishes a non-active lake from a missing one', async () => {
    // An admin picking from the lake list CAN see a draft lake, so "not found" for a lake on
    // their screen would read as a bug.
    mockLakeFind.mockImplementation(async (id: string) => ({ ...activeLake(id), status: 'draft' }));
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: [LAKE_A] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(new RegExp(`Data lake is not active: ${LAKE_A}`));
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('rejects an archived lake too', async () => {
    mockLakeFind.mockImplementation(async (id: string) => ({ ...activeLake(id), status: 'archived' }));
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: [LAKE_A] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/not active/i);
  });

  it('rejects a lake the target user does not manage, naming it, and does not mint', async () => {
    mockFilterManaged.mockResolvedValue([]);
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: [LAKE_A] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(
      new RegExp(`does not manage data lake\\(s\\): ${LAKE_A}`)
    );
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('keeps the managed subset out of the rejection message', async () => {
    mockFilterManaged.mockImplementation(async (lakes: { id: string }[]) => lakes.filter(l => l.id === LAKE_A));
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: [LAKE_A, LAKE_B] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(
      new RegExp(`does not manage data lake\\(s\\): ${LAKE_B}\\.`)
    );
  });

  it('offers no override: an unmanaged lake is refused however the body is dressed up', async () => {
    mockFilterManaged.mockResolvedValue([]);
    const { req, res } = post({
      name: 'preprovisioned',
      scopes: ['notebooks:read'],
      preauthorizedLakeIds: [LAKE_A],
      allowUnmanagedLakes: true,
    });
    await expect(mockRefs.postHandler!(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it('tells the operator to fix the grant rather than to bypass the screen', async () => {
    mockFilterManaged.mockResolvedValue([]);
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: [LAKE_A] });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/Grant the user access to the lake first/i);
  });

  it('names the bound lakes in the audit line', async () => {
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: [LAKE_A] });
    await mockRefs.postHandler!(req, res);
    const logged = ((req as any).logger.info as any).mock.calls[0][0] as string;
    expect(logged).toContain(`bound to data lake(s) ${LAKE_A}`);
  });

  it('leaves the audit line unchanged when no lake is bound', async () => {
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'] });
    await mockRefs.postHandler!(req, res);
    const logged = ((req as any).logger.info as any).mock.calls[0][0] as string;
    expect(logged).not.toContain('bound to data lake');
  });

  it('records the binding on the analytics event', async () => {
    const { req, res } = post({
      name: 'key',
      scopes: ['notebooks:read'],
      preauthorizedLakeIds: [LAKE_A, LAKE_B],
    });
    await mockRefs.postHandler!(req, res);
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ preauthorizedLakeIds: [LAKE_A, LAKE_B] }),
      }),
      expect.anything()
    );
  });

  it('leaves the analytics lake field absent when no lake is bound', async () => {
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'] });
    await mockRefs.postHandler!(req, res);
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ preauthorizedLakeIds: undefined }) }),
      expect.anything()
    );
  });

  it('escapes a forged newline in the key name so it cannot fake a sibling audit entry', async () => {
    const { req, res } = post({
      name: 'ok\nAdmin nobody (0) generated API key "evil" for user victim',
      scopes: ['notebooks:read'],
      preauthorizedLakeIds: [LAKE_A],
    });
    await mockRefs.postHandler!(req, res);
    const logged = ((req as any).logger.info as any).mock.calls[0][0] as string;
    expect(logged).not.toContain('\n');
    expect(logged).toContain('\\n');
  });
});

/**
 * The target id is canonicalized once, off `targetUser.id`, and used for the mint as well as the
 * lake screen. `userRepository.findById` casts to ObjectId and so resolves the user under any hex
 * casing, but `UserApiKeyModel.userId` is `type: String`: a key minted under a non-canonical
 * segment authenticates (apiKeyAuth casts too) and is then invisible to every byte-exact
 * owner-scoped query - findByUserId, countActiveByUserId, findByUserIdAndId.
 */
describe('POST /api/admin/users/:userId/generate-api-key - canonical target id', () => {
  const SEGMENT_UPPER = '0123456789ABCDEF01234567';
  const CANONICAL = '0123456789abcdef01234567';

  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFind.mockResolvedValue({ id: CANONICAL, username: 'targetUser' });
    mockCreateKey.mockResolvedValue({ id: 'k1', name: 'key', scopes: ['notebooks:read'] });
    mockLogEvent.mockResolvedValue(undefined);
  });

  it('mints under the resolved user id, not the raw URL segment', async () => {
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'] }, { userId: SEGMENT_UPPER });
    await mockRefs.postHandler!(req, res);
    expect(mockUserFind).toHaveBeenCalledWith(SEGMENT_UPPER);
    expect(mockCreateKey).toHaveBeenCalledWith(CANONICAL, expect.anything(), expect.anything());
  });

  it('attributes the analytics event to the resolved user id', async () => {
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'] }, { userId: SEGMENT_UPPER });
    await mockRefs.postHandler!(req, res);
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ userId: CANONICAL }), expect.anything());
  });

  it('records the resolved user id on the audit line', async () => {
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'] }, { userId: SEGMENT_UPPER });
    await mockRefs.postHandler!(req, res);
    const logged = ((req as any).logger.info as any).mock.calls[0][0] as string;
    expect(logged).toContain(CANONICAL);
    expect(logged).not.toContain(SEGMENT_UPPER);
  });

  it('screens the lake binding against the resolved user id', async () => {
    mockLakeFind.mockImplementation(async (id: string) => activeLake(id));
    mockFilterManaged.mockImplementation(async (lakes: { id: string }[]) => lakes);
    const { req, res } = post(
      { name: 'key', scopes: ['notebooks:read'], preauthorizedLakeIds: [LAKE_A] },
      { userId: SEGMENT_UPPER }
    );
    await mockRefs.postHandler!(req, res);
    expect(mockFilterManaged.mock.calls[0][1]).toBe(CANONICAL);
  });

  it('escapes a forged newline in either username so it cannot fake a sibling audit entry', async () => {
    mockUserFind.mockResolvedValue({
      id: CANONICAL,
      username: 'victim\nAdmin nobody (0) generated API key "evil" for user someone',
    });
    const { req, res } = post({ name: 'key', scopes: ['notebooks:read'] });
    (req as any).user.username = 'admin\nforged';
    await mockRefs.postHandler!(req, res);
    const logged = ((req as any).logger.info as any).mock.calls[0][0] as string;
    expect(logged).not.toContain('\n');
    expect(logged).toContain('\\n');
  });
});
