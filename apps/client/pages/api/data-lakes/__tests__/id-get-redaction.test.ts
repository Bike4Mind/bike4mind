import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Proves the single-lake GET is WIRED to the redaction, not merely that the redaction works.
 * The service-level tests cover `redactLakeForActor` itself; without this, deleting the call in
 * `[id].ts` and returning the raw document leaves every other suite green - and that line is the
 * whole point of the endpoint's change.
 *
 * The real `redactLakeForActor` is used deliberately (only the access gate is stubbed), so this
 * also pins the end-to-end behaviour a reader actually sees: key ABSENT, not blanked.
 */
const h = vi.hoisted(() => ({
  assertLakeAccess: vi.fn(),
  toAccessContext: vi.fn(),
  computeDataLakeStats: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.PUT = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  // The config-audit repos this route wires (see lakeConfigAuditDb). Stubbed rather than
  // omitted because the mock replaces the whole module: a missing export is an import-time
  // failure, not a silent undefined.
  lakeConfigChangeEventRepository: { record: vi.fn().mockResolvedValue({}) },
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
  dataLakeBatchRepository: {},
  fabFileRepository: { computeDataLakeStats: h.computeDataLakeStats },
  dataLakeAccessGrantRepository: {
    listByLake: vi.fn().mockResolvedValue([]),
    listActiveByLakes: vi.fn().mockResolvedValue([]),
    listByPrincipal: vi.fn().mockResolvedValue([]),
    findGrant: vi.fn().mockResolvedValue(null),
    upsertGrant: vi.fn().mockResolvedValue({}),
    removeGrant: vi.fn().mockResolvedValue(true),
    removeAllForLake: vi.fn().mockResolvedValue(0),
  },
  // The GET read gate reads the EnforceLakeReadGrants cutover flag (#1673) via assertLakeAccess;
  // default off keeps these redaction tests on the legacy report-only path.
  adminSettingsRepository: { getSettingsValue: vi.fn().mockResolvedValue(false) },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@bike4mind/services', async () => {
  // Real redaction, stubbed gate: the point is the wiring between them.
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    dataLakeService: {
      ...actual.dataLakeService,
      assertLakeAccess: h.assertLakeAccess,
    },
  };
});

import { DATA_LAKES } from '@bike4mind/common';
import handler from '../[id]';

const PROMPT = 'Always begin your reply with the token LAKEPROMPT-OK.';
const publishedLake = {
  id: 'lake1',
  slug: 'lake1',
  name: 'Published Lake',
  fileTagPrefix: 'lk:',
  datalakeTag: 'datalake:lake1',
  createdByUserId: 'owner',
  status: 'active',
  isPublic: true,
  systemPrompt: PROMPT,
};

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const get = () => ({ method: 'GET', query: { id: 'lake1' } }) as never;
const run = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe('GET /api/data-lakes/[id] - editor-only redaction is wired into the handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.assertLakeAccess.mockResolvedValue(publishedLake);
  });

  it('withholds systemPrompt from a stranger who can READ the published lake', async () => {
    h.toAccessContext.mockResolvedValue({ userId: 'stranger', isAdmin: false, userTags: [] });
    const { res, json } = makeRes();

    await run(get(), res);

    const body = json.mock.calls[0][0];
    expect('systemPrompt' in body).toBe(false);
    // Everything a reader is entitled to still comes back.
    expect(body.name).toBe('Published Lake');
    expect(body.datalakeTag).toBe('datalake:lake1');
  });

  it('returns systemPrompt to the lake owner', async () => {
    h.toAccessContext.mockResolvedValue({ userId: 'owner', isAdmin: false, userTags: [] });
    const { res, json } = makeRes();

    await run(get(), res);

    expect(json.mock.calls[0][0].systemPrompt).toBe(PROMPT);
  });

  it('returns systemPrompt to an admin who does not own the lake', async () => {
    h.toAccessContext.mockResolvedValue({ userId: 'someone-else', isAdmin: true, userTags: [] });
    const { res, json } = makeRes();

    await run(get(), res);

    expect(json.mock.calls[0][0].systemPrompt).toBe(PROMPT);
  });
});

/**
 * A registry lake has no document, so it has no persisted stats to serialize - the fields were
 * simply absent while the same lake's /articles reported a real total. The handler computes them
 * live for that case only.
 *
 * Worth its own block because nothing else reaches it: every fixture above is a DB lake, so the
 * branch is skipped and CI stays green whether or not it works. It also fails SILENTLY into the
 * exact pre-change response, which makes "the fix is broken" and "the fix is not deployed"
 * indistinguishable from the outside.
 */
describe('GET /api/data-lakes/[id] - live stats for a registry lake', () => {
  // A real registry id, so the handler's own isFallbackLake (not a stub) selects the branch.
  const registryLake = {
    ...DATA_LAKES[0],
    createdByUserId: '',
    status: 'active',
  };
  const getRegistry = () => ({ method: 'GET', query: { id: registryLake.id } }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    h.assertLakeAccess.mockResolvedValue(registryLake);
    h.toAccessContext.mockResolvedValue({ userId: 'reader', isAdmin: false, userTags: [] });
  });

  it('merges live fileCount/totalSizeBytes onto a registry lake', async () => {
    h.computeDataLakeStats.mockResolvedValue({ fileCount: 86, totalSizeBytes: 4096, totalChunkedChars: 9 });
    const { res, json } = makeRes();

    await run(getRegistry(), res);

    const body = json.mock.calls[0][0];
    expect(body.fileCount).toBe(86);
    expect(body.totalSizeBytes).toBe(4096);
    // Scoped through the registry arm - an owned scope here would drop the prefix and report 0.
    expect(h.computeDataLakeStats).toHaveBeenCalledWith({
      kind: 'registry',
      datalakeTag: registryLake.datalakeTag,
      fileTagPrefix: registryLake.fileTagPrefix,
    });
  });

  it('still serializes the lake when the stats aggregate throws, rather than failing the read', async () => {
    h.computeDataLakeStats.mockRejectedValue(new Error('aggregate exploded'));
    const { res, json } = makeRes();

    await run(getRegistry(), res);

    const body = json.mock.calls[0][0];
    expect(body.datalakeTag).toBe(registryLake.datalakeTag);
    // Degrades to the un-augmented lake: supporting detail must not take the endpoint down.
    expect(body.fileCount).toBeUndefined();
  });

  it('does not compute stats for an ordinary DB lake, which carries persisted ones', async () => {
    h.assertLakeAccess.mockResolvedValue(publishedLake);
    const { res } = makeRes();

    await run(get(), res);

    expect(h.computeDataLakeStats).not.toHaveBeenCalled();
  });
});
