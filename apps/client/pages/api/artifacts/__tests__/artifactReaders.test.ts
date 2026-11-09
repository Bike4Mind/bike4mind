// @vitest-environment node
/**
 * GET /api/artifacts/[id] and GET /api/artifacts/[id]/versions by caller. The real artifactService
 * runs (only the repositories are fake) so the viewer projection is exercised, not mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mockRefs = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: any, res: any) => Promise<unknown>>,
  doc: null as unknown,
  current: undefined as string | undefined,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {};
  for (const m of ['get', 'put', 'post', 'delete']) {
    chain[m] = (fn: any) => {
      mockRefs.handlers[`${m}:${mockRefs.current ?? ''}`] = fn;
      return chain;
    };
  }
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/services', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return { artifactService: actual.artifactService };
});

vi.mock('@bike4mind/database', () => ({
  artifactRepository: { findOne: async () => mockRefs.doc, find: async () => [] },
  artifactContentRepository: { findLatestContent: async () => ({ content: 'body' }) },
  artifactVersionRepository: {
    findByArtifactId: async () => [{ _id: 'v1', artifactId: 'a1', version: 1, createdBy: 'owner', changes: [] }],
  },
}));

const stored = {
  _id: 'm1',
  id: 'a1',
  type: 'html',
  title: 'T',
  version: 1,
  status: 'draft',
  tags: [],
  visibility: 'public',
  metadata: {},
  contentHash: 'h',
  contentSize: 4,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-02'),
  userId: 'owner',
  organizationId: 'org',
  sessionId: 'sess',
  permissions: { canRead: ['sharee'], canWrite: [], canDelete: [], isPublic: false },
};

async function load() {
  mockRefs.current = 'byId';
  await import('../[id]/index');
  mockRefs.current = 'versions';
  await import('../[id]/versions');
  return { byId: mockRefs.handlers['get:byId'], versions: mockRefs.handlers['get:versions'] };
}

async function run(handler: (req: any, res: any) => Promise<unknown>, userId: string) {
  const { req, res } = createMocks({ method: 'GET', query: { id: 'a1', includeContent: 'true' } });
  (req as any).user = { id: userId };
  await handler(req, res);
  return res._getJSONData();
}

describe('artifact readers', () => {
  beforeEach(() => {
    mockRefs.doc = stored;
  });

  it.each(['owner', 'sharee'])('%s sees the owner id, permissions and version authors', async who => {
    const { byId, versions } = await load();
    const body = await run(byId, who);
    expect(body.artifact.userId).toBe('owner');
    expect(body.artifact.permissions).toBeDefined();
    expect(body.content.content).toBe('body');
    expect((await run(versions, who)).data[0].createdBy).toBe('owner');
  });

  it('a public stranger sees the viewer shape only', async () => {
    const { byId, versions } = await load();
    const body = await run(byId, 'stranger');
    expect(body.artifact).toMatchObject({ id: 'a1', title: 'T', type: 'html', version: 1, metadata: {} });
    expect(body.artifact.updatedAt).toBeDefined();
    expect(body.content.content).toBe('body');
    for (const k of ['userId', 'permissions', 'organizationId', 'sessionId'])
      expect(body.artifact).not.toHaveProperty(k);
    expect((await run(versions, 'stranger')).data[0]).not.toHaveProperty('createdBy');
  });
});
