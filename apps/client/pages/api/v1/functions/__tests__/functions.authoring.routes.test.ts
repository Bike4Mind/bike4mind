// @vitest-environment node
/**
 * Route tests for the public authoring routes under /api/v1/functions. `baseApi`, the database, the artifact service,
 * and the setting are stubbed; the contract prelude and the callable function services run for real, so ownership is
 * proved by the same checks the app's routes rely on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { calculateContentHash, isZodError, type FunctionContract } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  enabled: { value: true },
  functions: [] as Record<string, unknown>[],
  artifacts: [] as { id: string; userId: string; type: string; version: number; deletedAt: Date | null }[],
  contents: [] as { artifactId: string; version: number; content: string; contentHash: string }[],
  writes: [] as string[],
  artifactCreate: vi.fn(),
  artifactUpdate: vi.fn(),
  artifactDelete: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  methodNotAllowedHandler: () => async (_req: unknown, res: { status: (code: number) => { end: () => void } }) =>
    res.status(405).end(),
  baseApi: () => {
    type Mw = (req: unknown, res: unknown, next: (error?: unknown) => void) => unknown;
    const used: Mw[] = [];
    const compose =
      (...handlers: Mw[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of [...used, ...handlers]) {
          let advanced = false;
          let failure: unknown;
          await handler(req, res, (error?: unknown) => {
            advanced = true;
            failure = error;
          });
          if (failure) throw failure;
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = (mw: Mw) => {
      used.push(mw);
      return chain;
    };
    for (const verb of ['get', 'post', 'patch', 'delete', 'put']) chain[verb] = compose;
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
vi.mock('@bike4mind/server-utils/callableFunctions/access', async () => {
  const { ForbiddenError } = await import('@bike4mind/common');
  return {
    resolveCallableFunctionsEnabled: async () => h.enabled.value,
    assertCallableFunctionsEnabled: async () => {
      if (!h.enabled.value) throw new ForbiddenError('Callable functions are turned off for this account.');
    },
  };
});
vi.mock('@bike4mind/services', () => ({
  artifactService: { create: h.artifactCreate, update: h.artifactUpdate, delete: h.artifactDelete },
}));

type Owner = { ownerType: string; ownerKey: string };
const mine = (id: string, owner: Owner) => h.functions.find(fn => fn.id === id && fn.ownerKey === owner.ownerKey);
const write = (name: string, id: string, owner: Owner, change: Record<string, unknown>) => {
  const fn = mine(id, owner);
  if (!fn) return null;
  h.writes.push(name);
  Object.assign(fn, change, { updatedAt: new Date() });
  return fn;
};

vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  callableFunctionRepository: {
    findByIdForOwner: async (id: string, owner: Owner) => mine(id, owner) ?? null,
    listForOwner: async (owner: Owner) => h.functions.filter(fn => fn.ownerKey === owner.ownerKey),
    findBySlugForOwner: async (slug: string, owner: Owner) =>
      h.functions.find(fn => fn.slug === slug && fn.ownerKey === owner.ownerKey) ?? null,
    createWithinOwnerCap: async (doc: Record<string, unknown>) => {
      const { CallableFunctionSlugConflictError } = await import('@bike4mind/common');
      if (h.functions.some(fn => fn.slug === doc.slug && fn.ownerKey === doc.ownerKey)) {
        throw new CallableFunctionSlugConflictError(doc.slug as string);
      }
      h.writes.push('create');
      const created = {
        ...doc,
        id: `6f${String(h.functions.length + 1).padStart(22, '0')}`,
        state: 'draft',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      h.functions.push(created);
      return created;
    },
    repin: async (id: string, owner: Owner, _seen: number, change: Record<string, unknown>) =>
      write('repin', id, owner, { ...change, state: 'draft' }),
    setEnabled: async (id: string, owner: Owner, enabled: boolean) => write('setEnabled', id, owner, { enabled }),
    setApproval: async (id: string, owner: Owner, approval: string) => write('setApproval', id, owner, { approval }),
    setExamples: async (id: string, owner: Owner, _guard: unknown, examples: unknown[]) =>
      write('setExamples', id, owner, { examples }),
    setGrants: async (id: string, owner: Owner, grants: unknown) => write('setGrants', id, owner, { grants }),
    deleteForOwner: async (id: string, owner: Owner) => !!write('delete', id, owner, {}),
  },
  callableFunctionReviewRepository: { deleteForFunction: async () => undefined },
  callableFunctionCallRepository: {
    summarizeForOwner: async () => ({ since: new Date(0), total: 0, outcomes: {}, recent: [] }),
  },
  artifactRepository: {
    find: async (filter: { id: { $in: string[] }; userId: string }) =>
      h.artifacts.filter(a => filter.id.$in.includes(a.id) && a.userId === filter.userId),
    findOne: async (filter: { id: string; userId?: string }) =>
      h.artifacts.find(a => a.id === filter.id && (!filter.userId || a.userId === filter.userId)) ?? null,
  },
  artifactContentRepository: {
    findByArtifactAndVersion: async (artifactId: string, version: number) =>
      h.contents.find(row => row.artifactId === artifactId && row.version === version) ?? null,
  },
  userRepository: { find: async () => [{ _id: 'u3', name: 'Recipient Three' }] },
}));
vi.mock('@bike4mind/server-utils/callableFunctions/dataPins', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/callableFunctions/dataPins')>()),
  deleteCallableFunctionDataObjects: async () => undefined,
}));

const { default: collectionRoute } = await import('@pages/api/v1/functions/index');
const { default: mineRoute } = await import('@pages/api/v1/functions/mine');
const { default: functionRoute } = await import('@pages/api/v1/functions/[id]/index');
const { default: sourceRoute } = await import('@pages/api/v1/functions/[id]/source');
const { default: codeRoute } = await import('@pages/api/v1/functions/[id]/code');
const { default: examplesRoute } = await import('@pages/api/v1/functions/[id]/examples');
const { default: testRunsRoute } = await import('@pages/api/v1/functions/[id]/test-runs');
const { default: dataRoute } = await import('@pages/api/v1/functions/[id]/data/index');
const { default: dataNameRoute } = await import('@pages/api/v1/functions/[id]/data/[name]');
const { default: sourcesRoute } = await import('@pages/api/v1/functions/[id]/sources');
const { default: promoteRoute } = await import('@pages/api/v1/functions/[id]/promote');
const { default: shareRoute } = await import('@pages/api/v1/functions/[id]/share');
const { default: recipientRoute } = await import('@pages/api/v1/functions/[id]/recipient');
const { default: callsRoute } = await import('@pages/api/v1/functions/[id]/calls');

const CONTRACT: FunctionContract = {
  name: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam.',
  inputs: {
    type: 'object',
    properties: { span: { type: 'number', unit: 'm', exclusiveMinimum: 0 } },
    required: ['span'],
    additionalProperties: false,
  },
  outputs: {
    type: 'object',
    properties: { deflection: { type: 'number', unit: 'm' } },
    required: ['deflection'],
    additionalProperties: false,
  },
  tests: [{ name: 'unit span', input: { span: 1 }, expected: { deflection: 1 } }],
};
const CODE = 'FUNCTION = {"name": "beam_midspan_deflection"}\n\ndef run(inputs):\n    return {"deflection": 1}\n';

const T0 = new Date('2026-11-20T10:00:00.000Z');
const OWNED_ID = '6b0000000000000000000001';
const SHARED_ID = '6b0000000000000000000002';

const fnDoc = (id: string, ownerKey: string, overrides: Record<string, unknown> = {}) => ({
  id,
  ownerType: 'user',
  ownerKey,
  userId: ownerKey,
  slug: CONTRACT.name,
  description: CONTRACT.description,
  state: 'live',
  enabled: true,
  pin: {
    artifactId: `artifact-${id}`,
    version: 3,
    contentHash: 'c'.repeat(64),
    source: CODE,
    pinnedAt: T0,
    seq: 1,
    dataPins: [{ name: 'table.csv', sha256: 'd'.repeat(64), bytes: 12, sourceFileId: 'f1', pinnedAt: T0 }],
  },
  contract: CONTRACT,
  trustLabel: 'unverified',
  examples: [],
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

type AnyHandler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(
  handler: unknown,
  {
    method = 'GET',
    query = {},
    body,
    user = 'u1',
  }: { method?: string; query?: Record<string, string>; body?: unknown; user?: string }
) {
  const { req, res } = createMocks({ method: method as 'GET', query, body: body as object });
  Object.assign(req, { user: { id: user }, logger, headers: {}, apiKeyInfo: { keyId: 'k1' } });
  try {
    await (handler as AnyHandler)(req, res);
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? (isZodError(error) ? 422 : 500);
    const info = (error as { additionalInfo?: Record<string, unknown> }).additionalInfo ?? {};
    return { status, body: { error: (error as Error).message, ...info } as Record<string, unknown> };
  }
  const text = res._getData();
  return {
    status: res._getStatusCode(),
    body: (typeof text === 'string' && text ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

const addArtifact = (id: string, userId: string, version: number, content: string) => {
  h.artifacts.push({ id, userId, type: 'python', version, deletedAt: null });
  h.contents.push({ artifactId: id, version, content, contentHash: calculateContentHash(content) });
};

beforeEach(() => {
  vi.clearAllMocks();
  h.enabled.value = true;
  h.writes = [];
  h.artifacts = [];
  h.contents = [];
  h.functions = [fnDoc(OWNED_ID, 'u1'), fnDoc(SHARED_ID, 'u1', { grants: { visibility: 'private', userIds: ['u2'] } })];
  addArtifact(`artifact-${OWNED_ID}`, 'u1', 3, CODE);
  addArtifact(`artifact-${SHARED_ID}`, 'u1', 3, CODE);
  h.artifactCreate.mockImplementation(async (userId: string, params: { content: string }) => {
    const id = `artifact-new-${h.artifacts.length}`;
    addArtifact(id, userId, 1, params.content);
    return { artifact: { id, version: 1 } };
  });
  h.artifactUpdate.mockImplementation(async (userId: string, params: { id: string; content: string }) => {
    const artifact = h.artifacts.find(a => a.id === params.id && a.userId === userId)!;
    artifact.version += 1;
    h.contents.push({
      artifactId: artifact.id,
      version: artifact.version,
      content: params.content,
      contentHash: calculateContentHash(params.content),
    });
    return { artifact: { id: artifact.id, version: artifact.version } };
  });
  h.artifactDelete.mockResolvedValue({});
});

describe("authoring the key owner's own function", () => {
  it('creates a draft from code alone, writing the artifact and pinning it', async () => {
    const res = await call(collectionRoute, {
      method: 'POST',
      body: { code: CODE, contract: { ...CONTRACT, name: 'plate_buckling' } },
    });
    expect(res.status).toBe(201);
    const data = res.body.data as Record<string, unknown>;
    expect(data).toMatchObject({ slug: 'plate_buckling', state: 'draft', status: 'draft', code: CODE, pin_version: 1 });
    expect(h.artifactCreate).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ type: 'python', content: CODE, visibility: 'private' }),
      expect.anything()
    );
  });

  it('refuses a contract with problems before writing any artifact', async () => {
    const res = await call(collectionRoute, { method: 'POST', body: { code: CODE, contract: { name: 'x' } } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_contract');
    expect(h.artifactCreate).not.toHaveBeenCalled();
  });

  it('removes the new artifact when the create is refused', async () => {
    const res = await call(collectionRoute, { method: 'POST', body: { code: CODE, contract: CONTRACT } });
    expect(res.status).toBe(409);
    expect(h.artifactDelete).toHaveBeenCalledWith('u1', { id: 'artifact-new-2', hardDelete: false }, expect.anything());
  });

  it('saves new code as an artifact version and returns the function to draft', async () => {
    const next = `${CODE}# tuned\n`;
    const res = await call(codeRoute, {
      method: 'PUT',
      query: { id: OWNED_ID },
      body: { code: next, contract: CONTRACT, pin_version: 3 },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ state: 'draft', pin_version: 4, code: next });
  });

  it('refuses a stale pin_version without writing a version', async () => {
    const res = await call(codeRoute, {
      method: 'PUT',
      query: { id: OWNED_ID },
      body: { code: CODE, contract: CONTRACT, pin_version: 2 },
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'version_changed', version: 3 });
    expect(h.artifactUpdate).not.toHaveBeenCalled();
  });

  it('refuses a renamed function without writing a version', async () => {
    const res = await call(codeRoute, {
      method: 'PUT',
      query: { id: OWNED_ID },
      body: { code: CODE, contract: { ...CONTRACT, name: 'other_name' }, pin_version: 3 },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('name_changed');
    expect(h.artifactUpdate).not.toHaveBeenCalled();
  });

  it('reads its own function with its code, and lists drafts with live ones', async () => {
    h.functions.push(fnDoc('6b0000000000000000000003', 'u1', { state: 'draft', slug: 'draft_one' }));
    const read = await call(sourceRoute, { query: { id: OWNED_ID } });
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({ id: OWNED_ID, code: CODE, contract: CONTRACT, trust_label: 'unverified' });
    const list = await call(mineRoute, { query: {} });
    expect((list.body.data as { slug: string }[]).map(fn => fn.slug)).toContain('draft_one');
  });

  it('turns its function off and shares and unshares it', async () => {
    const off = await call(functionRoute, { method: 'PATCH', query: { id: OWNED_ID }, body: { enabled: false } });
    expect(off.body.data).toMatchObject({ enabled: false, status: 'disabled' });
    const unshared = await call(shareRoute, { method: 'DELETE', query: { id: SHARED_ID } });
    expect(unshared.body.data).toMatchObject({ share: null });
    const person = await call(recipientRoute, { query: { id: OWNED_ID, email: 'three@example.com' } });
    expect(person.body).toEqual({ data: { id: 'u3', name: 'Recipient Three' } });
  });

  it('refuses sharing a draft as not_live', async () => {
    h.functions[0]!.state = 'draft';
    const res = await call(shareRoute, {
      method: 'PUT',
      query: { id: OWNED_ID },
      body: { visibility: 'private', user_ids: ['u3'] },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_live');
  });

  it('answers 403 on every authoring route while callable functions are off', async () => {
    h.enabled.value = false;
    const res = await call(sourceRoute, { query: { id: OWNED_ID } });
    expect(res.status).toBe(403);
  });
});

describe('a function shared with the caller is not theirs to author', () => {
  const asRecipient: [string, unknown, { method?: string; query?: Record<string, string>; body?: unknown }][] = [
    ['read its code', sourceRoute, {}],
    ['save new code', codeRoute, { method: 'PUT', body: { code: CODE, contract: CONTRACT, pin_version: 3 } }],
    ['turn it off', functionRoute, { method: 'PATCH', body: { enabled: false } }],
    ['delete it', functionRoute, { method: 'DELETE' }],
    ['set its examples', examplesRoute, { method: 'PUT', body: { examples: [] } }],
    ['run its tests', testRunsRoute, { method: 'POST', body: {} }],
    ['pin data to it', dataRoute, { method: 'POST', body: { file_id: 'f2', name: 'more.csv' } }],
    ['unpin its data', dataNameRoute, { method: 'DELETE', query: { name: 'table.csv' } }],
    ['set its sources', sourcesRoute, { method: 'PUT', body: { sources: [] } }],
    ['promote it', promoteRoute, { method: 'POST', body: {} }],
    ['read its share', shareRoute, {}],
    ['share it', shareRoute, { method: 'PUT', body: { visibility: 'private', user_ids: ['u3'] } }],
    ['unshare it', shareRoute, { method: 'DELETE' }],
    ['look up a recipient for it', recipientRoute, { query: { email: 'three@example.com' } }],
    ['read its calls', callsRoute, {}],
  ];

  it.each(asRecipient)('cannot %s', async (_action, route, options) => {
    const before = JSON.stringify(h.functions);
    const res = await call(route, { ...options, query: { id: SHARED_ID, ...options.query }, user: 'u2' });
    expect(res.status).toBe(404);
    expect(h.writes).toEqual([]);
    expect(JSON.stringify(h.functions)).toBe(before);
    expect(h.artifactUpdate).not.toHaveBeenCalled();
  });

  it('does not list it among their own functions', async () => {
    const res = await call(mineRoute, { query: {}, user: 'u2' });
    expect(res.body.data).toEqual([]);
  });
});
