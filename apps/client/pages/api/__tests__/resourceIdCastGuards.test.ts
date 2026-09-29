import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isObjectIdOrHexString } from 'mongoose';

/**
 * One reject-path test per shape by which a caller-supplied resource id used to reach a Mongoose
 * `_id` cast. A junk id is answered by the route itself - a 404, nothing written, nothing queried
 * - rather than by the error handler's `CastError path === '_id' -> 404` rule, which cannot tell
 * a caller's junk path param from a server-side cast and so reports both as an expected 404.
 *
 * The three shapes, and what each test is actually pinning:
 *   repository  - the guard lives in `BaseRepository.findById` (db-core), which resolves `null`
 *                 for a non-ObjectId. The repo is mocked here to behave the way the guarded one
 *                 does; what this file pins is that the ROUTE turns that `null` into its own 404.
 *                 The guard itself is pinned in db-core's BaseModel.test.ts and, against a real
 *                 server, in DataLakeModel.idOrSlugResolution.test.ts.
 *   model       - the route reaches a Mongoose model directly, so the guard is in the route. The
 *                 model spy must NEVER be called: that is the assertion that the cast cannot
 *                 happen, not just that the status came out right.
 *   $in filter  - one uncastable id rejects the WHOLE `$in` (pinned in
 *                 FabFileModel.objectIdCasting.integration.test.ts), so the route drops the
 *                 unusable entries and keeps the valid ones instead of failing the request.
 *   body id     - a malformed id in the request BODY answers 400, not 404 (CONVENTIONS.md), so
 *                 the guard feeds the route's existing 400 and the lookup never runs.
 */

const JUNK_ID = 'not-an-objectid';
const VALID_ID = '507f1f77bcf86cd799439011';

const handlers = vi.hoisted(() => ({
  get: null as null | ((req: any, res: any) => unknown),
  delete: null as null | ((req: any, res: any) => unknown),
  post: null as null | ((req: any, res: any) => unknown),
}));

// A contract route registers its param/body parsers ahead of the handler, so run the whole chain.
const runChain = (fns: Array<(req: any, res: any, next: () => void) => unknown>) => async (req: any, res: any) => {
  for (const fn of fns) await fn(req, res, () => undefined);
};

vi.mock('@server/middlewares/baseApi', () => {
  // Fresh per call: nextRouteForContract rewrites the verb registrars it is handed.
  const makeChain = () => {
    const chain: any = {
      use: () => chain,
      put: () => chain,
      patch: () => chain,
      get: (...fns: any[]) => {
        handlers.get = runChain(fns);
        return chain;
      },
      delete: (...fns: any[]) => {
        handlers.delete = runChain(fns);
        return chain;
      },
      post: (...fns: any[]) => {
        handlers.post = runChain(fns);
        return chain;
      },
    };
    return chain;
  };
  return { baseApi: () => makeChain() };
});

const spies = vi.hoisted(() => ({
  mementoFindById: vi.fn(),
  voiceFindOneAndDelete: vi.fn(),
  mcpServerFindOne: vi.fn(),
  mementoFind: vi.fn(),
  questFindById: vi.fn(),
  sessionFindById: vi.fn(),
  questModelFindById: vi.fn(),
  questModelUpdateOne: vi.fn(),
  modalFind: vi.fn(),
  annotationFindOne: vi.fn(),
  annotationCreate: vi.fn(),
}));

/**
 * Stands in for the guarded `BaseRepository.findById`: a non-ObjectId can never address a row, so
 * it resolves null without querying. Calls the same predicate the real one does, so this stand-in
 * cannot drift from what it emulates; the predicate itself is pinned against real code in db-core's
 * BaseModel.test.ts, so restating it here would add no coverage and could disagree silently.
 */
const guardedFindById = (spy: ReturnType<typeof vi.fn>, doc: unknown) => async (id: string) => {
  if (!isObjectIdOrHexString(id)) return null;
  spy(id);
  return doc;
};

vi.mock('@bike4mind/database', () => ({
  questRepository: {
    findById: guardedFindById(spies.questFindById, { id: VALID_ID, sessionId: VALID_ID, userId: 'u1' }),
  },
  sessionRepository: {
    findById: guardedFindById(spies.sessionFindById, { id: VALID_ID, userId: 'u1' }),
  },
  Voice: { findOneAndDelete: spies.voiceFindOneAndDelete, updateMany: vi.fn() },
  // The list route imports Memento from the package root; the [id] routes from /content.
  Memento: { find: spies.mementoFind, findById: spies.mementoFindById },
  Quest: { findById: spies.questModelFindById, updateOne: spies.questModelUpdateOne },
  telemetryAuditLogRepository: { createLog: vi.fn(async () => undefined) },
  adminSettingsRepository: {},
  ModalModel: { find: spies.modalFind },
  Annotation: { findOne: spies.annotationFindOne, create: spies.annotationCreate, countDocuments: async () => 0 },
  PublishedArtifact: {
    findOne: () => ({
      select: () => ({
        lean: async () => ({ publicId: 'pub1', visibility: 'public', commentPolicy: 'anyone', sha256Index: 'sha' }),
      }),
    }),
  },
}));

vi.mock('@bike4mind/database/content', () => ({
  Memento: { findById: spies.mementoFindById, find: spies.mementoFind },
}));

vi.mock('@bike4mind/database/ai', () => ({
  McpServer: { findOne: spies.mcpServerFindOne, findById: vi.fn(), findOneAndDelete: vi.fn() },
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/generatedFiles', () => ({ toGeneratedFiles: () => [] }));
vi.mock('@server/chatCompletion/questTimeoutRecovery', () => ({ resolveQuestTimeoutRecovery: () => null }));
vi.mock('@server/utils/sessionOwnership', () => ({ isSessionOwnedByUser: () => true }));
vi.mock('@server/utils/invokeMcpHandler', () => ({ invokeMcpHandler: () => Promise.resolve([]) }));
vi.mock('@bike4mind/mcp', () => ({ MCPClient: class {}, findForbiddenMcpEnvKeys: () => [] }));
vi.mock('@server/security/tokenEncryption', () => ({
  encryptEnvVariables: (v: unknown) => v,
  decryptEnvVariables: (v: unknown) => v,
}));
vi.mock('@server/utils/mcpEnvValidation', () => ({ assertNoForbiddenMcpEnvKeys: () => undefined }));
vi.mock('@server/utils/telemetryAnalysis', () => ({ DEFAULT_SLOS: {} }));
vi.mock('@bike4mind/services', () => ({ MODAL_SAFE_DEFAULT_KEY: 'customer' }));
vi.mock('@server/middlewares/optionalAuth', () => ({ optionalAuth: () => undefined }));
vi.mock('@server/services/publish', () => ({
  checkVisibility: async () => ({ ok: true }),
  canAnnotate: () => true,
  toPublishUser: () => ({}),
  authorDisplayName: () => 'u1',
  toAnnotationDto: () => ({}),
  requestHasGateProof: () => false,
}));

type Verb = 'get' | 'delete' | 'post';

const run = async (
  verb: Verb,
  load: () => Promise<unknown>,
  query: Record<string, unknown>,
  { body = {}, isAdmin = false }: { body?: Record<string, unknown>; isAdmin?: boolean } = {}
) => {
  handlers.get = null;
  handlers.delete = null;
  handlers.post = null;
  vi.resetModules();
  await load();
  const handler = handlers[verb];
  expect(handler).toBeTypeOf('function');

  const json = vi.fn();
  const status = vi.fn(() => ({ json, end: vi.fn() }));
  const res = { status, json } as any;
  const req = {
    method: verb.toUpperCase(),
    url: '/api/test',
    query,
    body,
    headers: {},
    user: { id: 'u1', isAdmin, email: 'u1@example.test' },
    ability: { can: () => true },
    logger: { updateMetadata: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
  } as any;

  const thrown = await Promise.resolve(handler!(req, res)).then(
    () => null,
    (e: unknown) => e
  );
  return { thrown, status, json };
};

/** Routes answer either by throwing a 404 HTTPError or by res.status(404). */
const answered404 = (thrown: unknown, status: ReturnType<typeof vi.fn>) =>
  (thrown !== null && (thrown as { statusCode?: number }).statusCode === 404) ||
  status.mock.calls.some(call => call[0] === 404);

describe('resource-id cast guards - a junk caller id is answered by the route, not the middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('repository shape - the route turns a guarded findById null into its own 404', () => {
    it('quests/[id] answers 404 for a junk quest id', async () => {
      const { thrown, status } = await run('get', () => import('@pages/api/quests/[id]/index'), { id: JUNK_ID });

      expect(answered404(thrown, status)).toBe(true);
      // The guarded repository short-circuits, so nothing was looked up.
      expect(spies.questFindById).not.toHaveBeenCalled();
      expect(spies.sessionFindById).not.toHaveBeenCalled();
    });

    it('quests/[id] still resolves a well-formed id', async () => {
      const { thrown, status } = await run('get', () => import('@pages/api/quests/[id]/index'), { id: VALID_ID });

      expect(answered404(thrown, status)).toBe(false);
      expect(spies.questFindById).toHaveBeenCalledWith(VALID_ID);
    });
  });

  describe('model shape - the route guards before the model is touched', () => {
    it('mementos/[id]/delete answers 404 and never calls findById', async () => {
      const { thrown, status } = await run('delete', () => import('@pages/api/mementos/[id]/delete'), {
        id: JUNK_ID,
      });

      expect(answered404(thrown, status)).toBe(true);
      expect(spies.mementoFindById).not.toHaveBeenCalled();
    });

    it('mementos/[id]/delete still queries for a well-formed id', async () => {
      spies.mementoFindById.mockResolvedValue(null);
      await run('delete', () => import('@pages/api/mementos/[id]/delete'), { id: VALID_ID });

      expect(spies.mementoFindById).toHaveBeenCalledWith(VALID_ID);
    });

    it('elabs/voice/[id] answers 404 and never calls findOneAndDelete', async () => {
      const { thrown, status } = await run('delete', () => import('@pages/api/elabs/voice/[id]/index'), {
        id: JUNK_ID,
      });

      expect(answered404(thrown, status)).toBe(true);
      expect(spies.voiceFindOneAndDelete).not.toHaveBeenCalled();
    });

    it('elabs/voice/[id] still queries for a well-formed id', async () => {
      spies.voiceFindOneAndDelete.mockResolvedValue(null);
      await run('delete', () => import('@pages/api/elabs/voice/[id]/index'), { id: VALID_ID });

      expect(spies.voiceFindOneAndDelete).toHaveBeenCalledWith({ _id: VALID_ID, userId: 'u1' });
    });

    it('mcp-servers/[id] answers 404 and never calls findOne', async () => {
      const { thrown, status } = await run('get', () => import('@pages/api/mcp-servers/[id]/index'), {
        id: JUNK_ID,
      });

      expect(answered404(thrown, status)).toBe(true);
      expect(spies.mcpServerFindOne).not.toHaveBeenCalled();
    });

    it('mcp-servers/[id] still queries for a well-formed id', async () => {
      spies.mcpServerFindOne.mockResolvedValue(null);
      await run('get', () => import('@pages/api/mcp-servers/[id]/index'), { id: VALID_ID });

      expect(spies.mcpServerFindOne).toHaveBeenCalledWith({ _id: VALID_ID, userId: 'u1' });
    });

    /** Resolves null whether the route awaits the query directly or chains `.select().lean()`. */
    const missingQuest = () => {
      const query = {
        select: () => query,
        lean: async () => null,
        then: (resolve: (v: null) => unknown) => resolve(null),
      };
      return query;
    };

    for (const verb of ['get', 'delete'] as const) {
      it(`admin/context-telemetry/[id] ${verb} answers 404 and never touches Quest`, async () => {
        const { thrown, status } = await run(
          verb,
          () => import('@pages/api/admin/context-telemetry/[id]'),
          { id: JUNK_ID },
          { isAdmin: true }
        );

        expect(answered404(thrown, status)).toBe(true);
        expect(spies.questModelFindById).not.toHaveBeenCalled();
        expect(spies.questModelUpdateOne).not.toHaveBeenCalled();
      });

      it(`admin/context-telemetry/[id] ${verb} still queries for a well-formed id`, async () => {
        spies.questModelFindById.mockImplementation(missingQuest);
        await run(verb, () => import('@pages/api/admin/context-telemetry/[id]'), { id: VALID_ID }, { isAdmin: true });

        expect(spies.questModelFindById).toHaveBeenCalledWith(VALID_ID);
      });
    }

    it('admin/context-telemetry/[id]/analyze answers 404 and never touches Quest', async () => {
      const { thrown, status } = await run(
        'post',
        () => import('@pages/api/admin/context-telemetry/[id]/analyze'),
        { id: JUNK_ID },
        { isAdmin: true }
      );

      expect(answered404(thrown, status)).toBe(true);
      expect(spies.questModelFindById).not.toHaveBeenCalled();
      expect(spies.questModelUpdateOne).not.toHaveBeenCalled();
    });

    it('admin/context-telemetry/[id]/analyze still queries for a well-formed id', async () => {
      spies.questModelFindById.mockImplementation(missingQuest);
      await run(
        'post',
        () => import('@pages/api/admin/context-telemetry/[id]/analyze'),
        { id: VALID_ID },
        { isAdmin: true }
      );

      expect(spies.questModelFindById).toHaveBeenCalledWith(VALID_ID);
    });
  });

  describe('$in shape - unusable ids are dropped, not fatal to the whole query', () => {
    const chainableFind = () => {
      const query: Record<string, unknown> = {};
      for (const method of ['sort', 'select', 'skip', 'limit']) {
        query[method] = vi.fn(() => query);
      }
      query.exec = vi.fn(async () => []);
      return query;
    };

    it('mementos keeps the castable ids and drops the rest', async () => {
      spies.mementoFind.mockImplementation(() => chainableFind());
      await run('get', () => import('@pages/api/mementos/index'), { ids: `${VALID_ID},${JUNK_ID}` });

      expect(spies.mementoFind).toHaveBeenCalledWith(expect.objectContaining({ _id: { $in: [VALID_ID] } }));
    });

    it('mementos drops the _id filter entirely when no id is castable', async () => {
      spies.mementoFind.mockImplementation(() => chainableFind());
      await run('get', () => import('@pages/api/mementos/index'), { ids: JUNK_ID });

      expect(spies.mementoFind).toHaveBeenCalledWith(expect.objectContaining({ _id: { $in: [] } }));
    });

    const modalQuery = () => ({ sort: () => ({ lean: async () => [] }) });

    it('admin/email/whats-new-content keeps the castable ids and drops the rest', async () => {
      spies.modalFind.mockImplementation(modalQuery);
      await run(
        'get',
        () => import('@pages/api/admin/email/whats-new-content'),
        { ids: `${VALID_ID}, ${JUNK_ID}` },
        { isAdmin: true }
      );

      expect(spies.modalFind).toHaveBeenCalledWith(expect.objectContaining({ _id: { $in: [VALID_ID] } }));
    });

    it('admin/email/whats-new-content matches nothing when no id is castable', async () => {
      spies.modalFind.mockImplementation(modalQuery);
      await run('get', () => import('@pages/api/admin/email/whats-new-content'), { ids: JUNK_ID }, { isAdmin: true });

      expect(spies.modalFind).toHaveBeenCalledWith(expect.objectContaining({ _id: { $in: [] } }));
    });
  });

  describe("body id - the guard feeds the route's existing 400 and the lookup never runs", () => {
    const postAnnotation = (threadRootId: string) =>
      run(
        'post',
        () => import('@pages/api/publish/annotations/[publicId]'),
        { publicId: 'pub1' },
        { body: { body: 'hi', threadRootId } }
      );

    it('publish/annotations/[publicId] answers 400 for a junk threadRootId and never calls findOne', async () => {
      const { thrown, status } = await postAnnotation(JUNK_ID);

      expect(thrown).toBeNull();
      expect(status).toHaveBeenCalledWith(400);
      expect(spies.annotationFindOne).not.toHaveBeenCalled();
      expect(spies.annotationCreate).not.toHaveBeenCalled();
    });

    it('publish/annotations/[publicId] still looks up a well-formed threadRootId', async () => {
      spies.annotationFindOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
      const { status } = await postAnnotation(VALID_ID);

      expect(spies.annotationFindOne).toHaveBeenCalledWith({ _id: VALID_ID, publicId: 'pub1', deletedAt: null });
      expect(status).toHaveBeenCalledWith(400);
    });
  });
});
