import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import '../index';

/**
 * The parser itself is pinned where `queryBool` is defined. These pin the plumbing: the bug
 * travelled qs.parse -> schema -> service, and only the last hop decides whether soft-deleted rows
 * are filtered, so a route that parsed correctly and then forwarded the raw query would still ship
 * it.
 */

// Collapse the baseApi().get().post() chain and capture the GET handler.
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  postHandler: null as null | ((req: any, res: any) => unknown),
  listArgs: undefined as unknown[] | undefined,
  createArgs: undefined as unknown[] | undefined,
  settings: {} as Record<string, boolean | undefined>,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/database', () => ({
  artifactRepository: { __repo: 'artifacts' },
  artifactContentRepository: { __repo: 'artifactContents' },
  artifactVersionRepository: { __repo: 'artifactVersions' },
  adminSettingsRepository: {
    getSettingsValue: (key: string) => Promise.resolve(mockRefs.settings[key]),
  },
}));

vi.mock('@server/utils/resolveActiveOrg', () => ({
  resolveActiveOrg: async (_req: unknown, orgId?: string) => {
    if (!orgId?.trim()) return undefined;
    if (orgId === 'foreign-org') {
      const { ForbiddenError } = await import('@server/utils/errors');
      throw new ForbiddenError('You are not a member of the selected organization.');
    }
    return orgId;
  },
}));

vi.mock('@server/utils/artifactSourceRefsGuards', () => {
  const sharedGuard = vi.fn();
  return {
    sharedGuard,
    createArtifactSourceRefsGuard: vi.fn(() => sharedGuard),
    createOwnedArtifactSourceRefsGuard: vi.fn(),
  };
});

vi.mock('@bike4mind/services', () => ({
  artifactService: {
    list: (...args: unknown[]) => {
      mockRefs.listArgs = args;
      return Promise.resolve({ artifacts: [], pagination: { total: 0 } });
    },
    create: (...args: unknown[]) => {
      mockRefs.createArgs = args;
      return Promise.resolve({ artifact: { id: 'a1' } });
    },
  },
}));

// Pulled in transitively by @server/utils/artifactGate, which imports it from the ./llm subpath -
// mocking it on the barrel intercepted nothing and let the real module load.
vi.mock('@bike4mind/services/llm/artifactGating', () => ({
  resolveArtifactsEnabled: (adminEnabled: boolean, requestedByCaller: boolean | undefined) =>
    adminEnabled && requestedByCaller !== false,
}));

function invokeGet(query: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'GET', url: '/api/artifacts', query: query as any });
  (req as any).user = { id: 'user-1' };
  return { req, res };
}

const includeDeletedArg = () => (mockRefs.listArgs?.[1] as { includeDeleted?: unknown } | undefined)?.includeDeleted;

describe('GET /api/artifacts', () => {
  it('hands the service a real boolean false for ?includeDeleted=false', async () => {
    expect(mockRefs.getHandler).toBeTypeOf('function');
    const { req, res } = invokeGet({ includeDeleted: 'false' });

    await mockRefs.getHandler!(req, res);

    expect(includeDeletedArg()).toBe(false);
  });

  it('hands the service true for ?includeDeleted=true', async () => {
    const { req, res } = invokeGet({ includeDeleted: 'true' });

    await mockRefs.getHandler!(req, res);

    expect(includeDeletedArg()).toBe(true);
  });

  it('defaults to false when the caller omits the param', async () => {
    const { req, res } = invokeGet({});

    await mockRefs.getHandler!(req, res);

    expect(includeDeletedArg()).toBe(false);
  });
});

/**
 * The artifact opt-out has to hold at the route, not just in the browser: chat mode parses the
 * finished quest client-side and posts the rows itself, so a caller that skips the client check
 * would otherwise write a durable row for a user who turned artifacts off.
 */
function invokePost(body: Record<string, unknown>, experimentalFeatures?: Record<string, boolean>) {
  const { req, res } = createMocks({ method: 'POST', url: '/api/artifacts', body: body as any });
  (req as any).user = { id: 'user-1', preferences: { experimentalFeatures } };
  return { req, res };
}

const aiBody = (extraMetadata: Record<string, unknown> = {}) => ({
  type: 'html',
  title: 'Generated page',
  content: '<html></html>',
  metadata: { aiGenerated: true, createdFrom: 'chat', ...extraMetadata },
});

describe('POST /api/artifacts artifact gate', () => {
  beforeEach(() => {
    mockRefs.createArgs = undefined;
    mockRefs.settings = { EnableArtifacts: true, EnableArtifactsDefault: true };
  });

  it('refuses an AI-authored create when the user turned artifacts off', async () => {
    const { req, res } = invokePost(aiBody(), { enableArtifacts: false });

    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(mockRefs.createArgs).toBeUndefined();
  });

  it('refuses an AI-authored create when the admin master switch is off', async () => {
    mockRefs.settings = { EnableArtifacts: false, EnableArtifactsDefault: true };
    const { req, res } = invokePost(aiBody(), { enableArtifacts: true });

    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(mockRefs.createArgs).toBeUndefined();
  });

  it('refuses an AI-authored create for a never-toggled user when the admin default is off', async () => {
    mockRefs.settings = { EnableArtifacts: true, EnableArtifactsDefault: false };
    const { req, res } = invokePost(aiBody(), {});

    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(403);
  });

  it('allows an AI-authored create when the user is opted in', async () => {
    const { req, res } = invokePost(aiBody(), { enableArtifacts: true });

    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(201);
    expect(mockRefs.createArgs?.[0]).toBe('user-1');
  });

  it('still allows a hand-authored create from a user who opted out', async () => {
    // The preference withdraws a feature; it does not seal the collection against the artifact
    // editor or the Knowledge viewer's create-on-404 fallback, neither of which sets aiGenerated.
    const { req, res } = invokePost(
      { type: 'html', title: 'Mine', content: '<html></html>' },
      { enableArtifacts: false }
    );

    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(201);
    expect(mockRefs.createArgs).toBeDefined();
  });
});

describe('POST /api/artifacts organization scope', () => {
  beforeEach(() => {
    mockRefs.createArgs = undefined;
    mockRefs.settings = { EnableArtifacts: true, EnableArtifactsDefault: true };
  });

  const body = (organizationId?: string) => ({ type: 'html', title: 'Page', content: '<html></html>', organizationId });

  it('rejects an organizationId the caller is not a member of with 403', async () => {
    const { req, res } = invokePost(body('foreign-org'));

    await expect(Promise.resolve(mockRefs.postHandler!(req, res))).rejects.toMatchObject({ statusCode: 403 });
    expect(mockRefs.createArgs).toBeUndefined();
  });

  it.each(['', '  '])('stores no organization for a blank organizationId (%j)', async blank => {
    const { req, res } = invokePost(body(blank));

    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(201);
    expect(mockRefs.createArgs?.[1]).toMatchObject({ organizationId: undefined });
  });

  it('creates under an organization the caller belongs to', async () => {
    const { req, res } = invokePost(body('member-org'));

    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(201);
    expect(mockRefs.createArgs?.[1]).toMatchObject({ organizationId: 'member-org' });
  });
});

describe('POST /api/artifacts reference guard', () => {
  it('hands the service the shared-access guard, not the owner-only one', async () => {
    mockRefs.settings = { EnableArtifacts: true, EnableArtifactsDefault: true };
    const guards = await import('@server/utils/artifactSourceRefsGuards');
    const { req, res } = invokePost({ type: 'html', title: 'Page', content: '<html></html>' });

    await mockRefs.postHandler!(req, res);

    const adapters = mockRefs.createArgs?.[2] as { assertSourceRefsAccessible: unknown };
    expect(guards.createArtifactSourceRefsGuard).toHaveBeenCalledWith((req as any).user);
    expect(adapters.assertSourceRefsAccessible).toBe((guards as any).sharedGuard);
    expect(guards.createOwnedArtifactSourceRefsGuard).not.toHaveBeenCalled();
  });
});
