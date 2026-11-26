// @vitest-environment node
/**
 * Route tests for the public research API under /api/v1/data-lakes/{id}. `baseApi`, the database and
 * the service layer are stubbed; the contract prelude, the shared handler bodies, the mapper and the
 * keyset helpers run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  ApiKeyScope,
  DATA_LAKE_READ_API_KEY_SCOPES,
  DATA_LAKE_WRITE_API_KEY_SCOPES,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  isZodError,
  decideDataLakeProposalContract,
  deleteDataLakeResearchConfigContract,
  getDataLakeConfigHistoryContract,
  getDataLakeResearchConfigContract,
  getDataLakeResearchRunContract,
  undoDataLakeConfigChangeContract,
  listDataLakeProposalsContract,
  listDataLakeResearchConfigsContract,
  listDataLakeResearchRunsContract,
  startDataLakeResearchRunContract,
  updateDataLakeResearchConfigContract,
  createDataLakeResearchConfigContract,
} from '@bike4mind/common';
import { decideScopeGate } from '@bike4mind/server-utils/middlewares/apiKeyScopeGate';

const h = vi.hoisted(() => ({
  rateLimitOptions: [] as Array<{ bucket?: string }>,
  baseApiOptions: [] as Array<Record<string, unknown> | undefined>,
  queue: { url: 'https://sqs.example/queue' as string | undefined },
  canManage: { value: true },
  lakeFound: { value: true },
  adminReached: vi.fn(),
  store: {
    configs: [] as Record<string, unknown>[],
    runs: [] as Record<string, unknown>[],
    proposals: [] as Record<string, unknown>[],
  },
  listConfigs: vi.fn(),
  listRuns: vi.fn(),
  listProposals: vi.fn(),
  createConfig: vi.fn(),
  updateConfig: vi.fn(),
  setPaused: vi.fn(),
  deleteConfig: vi.fn(),
  startRun: vi.fn(),
  enqueue: vi.fn(),
  admit: vi.fn(),
  approve: vi.fn(),
  decline: vi.fn(),
  restore: vi.fn(),
  findProposal: vi.fn(),
  history: vi.fn(),
  undo: vi.fn(),
  recordRead: vi.fn(),
  touch: vi.fn(),
}));

const LAKE_ID = '65a000000000000000000001';
const OTHER_LAKE_ID = '65a000000000000000000002';
const T0 = new Date('2026-03-01T00:00:00.000Z');

const gated = () => {
  if (!h.canManage.value) throw new ForbiddenError('You do not have permission to review proposals');
};

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options?: Record<string, unknown>) => {
    h.baseApiOptions.push(options);
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
    for (const verb of ['get', 'post', 'patch', 'delete', 'put']) chain[verb] = compose;
    return chain;
  },
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(405).json({ error: 'Method not allowed' }),
}));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({
  requireFeatureEnabled: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: { bucket?: string }) => {
    h.rateLimitOptions.push(options);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ isDevelopment: () => false }));
vi.mock('@bike4mind/server-utils/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
// Two distinct contexts: the admin one bypasses lake access and must never be built on these routes.
vi.mock('@bike4mind/server-utils/dataLakes/toAccessContext', () => ({
  toAccessContext: async () => {
    h.adminReached();
    return { userId: 'u1', isAdmin: true, userTags: [], organizationIds: [] };
  },
  toMemberAccessContext: async () => ({ userId: 'u1', isAdmin: false, userTags: [], organizationIds: [] }),
}));
vi.mock('@bike4mind/server-utils/dataLakes/lakeConfigAuditDb', () => ({ lakeConfigAuditDb: {} }));
vi.mock('@bike4mind/server-utils/dataLakes/queueResearchRun', () => ({ queueResearchRun: h.enqueue }));
vi.mock('@bike4mind/server-utils/utils/untrustedCompletionQuota', () => ({ admitRequestCompletion: h.admit }));
vi.mock('@bike4mind/server-utils/dataLakes/proposalAdmissionDeps', () => ({ admitProposedSource: vi.fn() }));
vi.mock('@bike4mind/server-utils/dataLakes/serializeLakeClaim', () => ({
  serializeLakeClaim: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@server/dataLakes/research/undoHandler', () => ({ undoLakeConfigChangeHandler: h.undo }));
vi.mock('@server/dataLakes/recordLakeRead', () => ({ recordLakeRead: h.recordRead }));
vi.mock('sst', () => ({
  Resource: {
    get dataLakeResearchQueue() {
      return h.queue.url ? { url: h.queue.url } : undefined;
    },
  },
}));
vi.mock('@bike4mind/database', () => ({
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
  adminSettingsRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeRepository: { touchIfStable: h.touch },
  dataLakeProposalRepository: {
    countPendingByLakes: async () => ({ [LAKE_ID]: 3 }),
    listByLake: h.listProposals,
    findById: h.findProposal,
  },
  dataLakeResearchConfigRepository: {
    findByIdInLake: async (id: string, lakeId: string) =>
      h.store.configs.find(c => c.id === id && c.dataLakeId === lakeId) ?? null,
  },
  dataLakeResearchRunRepository: {
    listByLake: h.listRuns,
    findByIdInLake: async (id: string, lakeId: string) =>
      h.store.runs.find(r => r.id === id && r.dataLakeId === lakeId) ?? null,
  },
  lakeConfigChangeEventRepository: {},
  lakeConfigUndoClaimRepository: {},
  lakeConfigSnapshotRepository: {},
  lakeMembershipChangeEventRepository: {},
  fabFileRepository: {},
  organizationRepository: {},
  spendFreezeRepository: {},
  userApiKeyRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    ...actual,
    dataLakeService: {
      ...actual.dataLakeService,
      assertLakeAccessById: async (id: string) => {
        if (id !== LAKE_ID || !h.lakeFound.value) throw new NotFoundError('Data lake not found');
        return { id: LAKE_ID, name: 'Handbook' };
      },
      assertLakeAccess: async (id: string) => {
        if (id !== LAKE_ID || !h.lakeFound.value) throw new NotFoundError('Data lake not found');
        return { id: LAKE_ID, name: 'Handbook' };
      },
      loadActiveLakeGrants: async () => [],
      canManageLake: () => h.canManage.value,
      resolveCanManageLake: async () => h.canManage.value,
      assembleLakeConfigHistory: h.history,
      // The manage gate for a decision lives in the service, so the stand-ins enforce it too.
      approveDataLakeProposal: async (...args: unknown[]) => (gated(), h.approve(...args)),
      declineDataLakeProposal: async (...args: unknown[]) => (gated(), h.decline(...args)),
      restoreDataLakeProposal: async (...args: unknown[]) => (gated(), h.restore(...args)),
    },
    dataLakeResearchService: {
      ...actual.dataLakeResearchService,
      listResearchConfigs: h.listConfigs,
      createResearchConfig: h.createConfig,
      updateResearchConfig: h.updateConfig,
      setResearchSchedulePaused: h.setPaused,
      deleteResearchConfig: h.deleteConfig,
      startResearchRun: h.startRun,
    },
  };
});

const { default: configsIndex } = await import('@pages/api/v1/data-lakes/[id]/research/configs/index');
const { default: configOne } = await import('@pages/api/v1/data-lakes/[id]/research/configs/[config_id]');
const { default: runsIndex } = await import('@pages/api/v1/data-lakes/[id]/research/runs/index');
const { default: runOne } = await import('@pages/api/v1/data-lakes/[id]/research/runs/[run_id]');
const { default: proposalsIndex } = await import('@pages/api/v1/data-lakes/[id]/proposals/index');
const { default: proposalOne } = await import('@pages/api/v1/data-lakes/[id]/proposals/[proposal_id]');
const { default: configHistory } = await import('@pages/api/v1/data-lakes/[id]/config-history');
const { default: undoChange } = await import('@pages/api/v1/data-lakes/[id]/config-history/[event_id]/undo');
// The limiters are built once, at module load, before any beforeEach clears the recorder.
const rateLimitBuckets = h.rateLimitOptions.map(o => o.bucket);

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const configDoc = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  dataLakeId: LAKE_ID,
  name: 'Weekly sweep',
  trigger: 'on_demand',
  cadence: 'off',
  reviewBacklogLimit: 25,
  nextRunAt: null,
  lastRunAt: null,
  createdByUserId: 'u1',
  source: 'search',
  feedUrl: null,
  query: 'coastal erosion',
  maxResults: 10,
  maxProposals: 5,
  trustedDomains: [],
  reviewDomains: [],
  unlistedSources: 'review',
  autoAdmitTrusted: false,
  maxAutoAdmits: 3,
  allowedDomains: [],
  blockedDomains: [],
  minRelevance: 0.6,
  costCeilingMicroUsd: 50_000,
  proposedTags: [],
  itemRules: [],
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

const runDoc = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  dataLakeId: LAKE_ID,
  configId: '65a0000000000000000000c1',
  trigger: 'on_demand',
  status: 'queued',
  startedByUserId: 'u1',
  startedAt: null,
  completedAt: null,
  createdAt: T0,
  spentMicroUsd: 0,
  levers: {
    source: 'search',
    feedUrl: null,
    query: 'q',
    maxResults: 10,
    maxProposals: 5,
    trustedDomains: [],
    reviewDomains: [],
    unlistedSources: 'review',
    allowedDomains: [],
    blockedDomains: [],
    minRelevance: 0.6,
    costCeilingMicroUsd: 50_000,
    proposedTags: [],
    itemRules: [],
  },
  totals: {},
  ...overrides,
});

const proposalDoc = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  dataLakeId: LAKE_ID,
  status: 'pending',
  sourceUrl: 'https://example.com/a',
  canonicalSourceKey: 'https://example.com/a',
  title: 'A report',
  excerpt: 'text',
  proposedTags: [],
  provenance: { producer: 'research_run', retrievedAt: T0 },
  createdAt: T0,
  updatedAt: T0,
  ...overrides,
});

interface CallOptions {
  method?: string;
  query?: Record<string, string>;
  body?: unknown;
  apiKey?: boolean;
}

type AnyHandler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(handler: unknown, { method = 'GET', query = {}, body, apiKey = false }: CallOptions) {
  const { req, res } = createMocks({ method: method as 'GET', query: { id: LAKE_ID, ...query }, body: body as object });
  Object.assign(req, {
    user: { id: 'u1', name: 'Casey' },
    logger,
    headers: {},
    ...(apiKey ? { apiKeyInfo: { keyId: 'k1', ownerUntrusted: true } } : {}),
  });
  try {
    await (handler as AnyHandler)(req, res);
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? (isZodError(error) ? 422 : 500);
    return { status, body: { error: (error as Error).message } as Record<string, unknown>, thrown: error };
  }
  const text = res._getData();
  return {
    status: res._getStatusCode(),
    body: (typeof text === 'string' && text ? JSON.parse(text) : {}) as Record<string, unknown>,
    thrown: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.queue.url = 'https://sqs.example/queue';
  h.canManage.value = true;
  h.lakeFound.value = true;
  h.store.configs = [];
  h.store.runs = [];
  h.store.proposals = [];
  h.admit.mockResolvedValue({ release: async () => {} });
  h.enqueue.mockResolvedValue(undefined);
  h.listConfigs.mockResolvedValue([]);
  h.listRuns.mockResolvedValue([]);
  h.listProposals.mockResolvedValue([]);
  h.history.mockResolvedValue({
    lakeId: LAKE_ID,
    lakeName: 'Handbook',
    entries: [],
    userNames: {},
    truncated: false,
    windowStartsAt: T0,
    generatedAt: T0,
  });
});

const CFG = '65a0000000000000000000c1';
const RUN = '65a0000000000000000000d1';
const PROP = '65a0000000000000000000e1';
const EVT = '65a0000000000000000000f1';

describe('scopes', () => {
  const READ = [...DATA_LAKE_READ_API_KEY_SCOPES];
  const WRITE = [...DATA_LAKE_WRITE_API_KEY_SCOPES];
  const ops = [
    ['listDataLakeResearchConfigs', listDataLakeResearchConfigsContract, READ],
    ['createDataLakeResearchConfig', createDataLakeResearchConfigContract, WRITE],
    ['getDataLakeResearchConfig', getDataLakeResearchConfigContract, READ],
    ['updateDataLakeResearchConfig', updateDataLakeResearchConfigContract, WRITE],
    ['deleteDataLakeResearchConfig', deleteDataLakeResearchConfigContract, WRITE],
    ['startDataLakeResearchRun', startDataLakeResearchRunContract, WRITE],
    ['listDataLakeResearchRuns', listDataLakeResearchRunsContract, READ],
    ['getDataLakeResearchRun', getDataLakeResearchRunContract, READ],
    ['listDataLakeProposals', listDataLakeProposalsContract, READ],
    ['decideDataLakeProposal', decideDataLakeProposalContract, WRITE],
    ['getDataLakeConfigHistory', getDataLakeConfigHistoryContract, READ],
    ['undoDataLakeConfigChange', undoDataLakeConfigChangeContract, WRITE],
  ] as const;

  it.each(ops)('%s declares its scopes and the 403 scope envelope', (_name, contract, scopes) => {
    expect(contract.auth).toBe('apiKeyOrJwt');
    expect(contract.emitsRateLimitHeaders).toBe(true);
    expect(contract.scopes).toEqual(scopes);
    expect(Object.keys(contract.responses)).toContain('403');
  });

  it.each(ops)('%s denies a key holding no data-lake scope', (_name, _contract, scopes) => {
    expect(decideScopeGate(scopes, [ApiKeyScope.AI_GENERATE], new Set())).toEqual({ outcome: 'deny' });
    expect(decideScopeGate(scopes, [scopes[0]], new Set())).toEqual({ outcome: 'allow' });
  });

  it('hands the contract scopes to the API-key chain for every route', () => {
    const required = h.baseApiOptions.map(o => o?.requiredScopes);
    expect(required.filter(s => JSON.stringify(s) === JSON.stringify(READ))).toHaveLength(6);
    expect(required.filter(s => JSON.stringify(s) === JSON.stringify(WRITE))).toHaveLength(6);
  });

  it('uses one stable rate-limit bucket per route family, with no lake id in it', () => {
    expect(rateLimitBuckets.filter(Boolean)).toHaveLength(12);
    expect(new Set(rateLimitBuckets).size).toBe(8);
    for (const bucket of rateLimitBuckets) expect(bucket).toMatch(/^\/api\/v1\/data-lakes\/\[id\]\//);
  });
});

describe('manage gate', () => {
  const cases: Array<[string, () => Promise<{ status: number }>]> = [
    ['list configs', () => call(configsIndex, {})],
    ['create config', () => call(configsIndex, { method: 'POST', body: { name: 'n', query: 'q' } })],
    ['get config', () => call(configOne, { query: { config_id: CFG } })],
    ['update config', () => call(configOne, { method: 'PATCH', query: { config_id: CFG }, body: { name: 'x' } })],
    ['delete config', () => call(configOne, { method: 'DELETE', query: { config_id: CFG } })],
    ['list runs', () => call(runsIndex, {})],
    ['start run', () => call(runsIndex, { method: 'POST', body: { config_id: CFG } })],
    ['get run', () => call(runOne, { query: { run_id: RUN } })],
    ['list proposals', () => call(proposalsIndex, {})],
    [
      'decide proposal',
      () => call(proposalOne, { method: 'POST', query: { proposal_id: PROP }, body: { decision: 'decline' } }),
    ],
    ['config history', () => call(configHistory, {})],
    ['undo', () => call(undoChange, { method: 'POST', query: { event_id: EVT } })],
  ];

  it.each(cases)('refuses a caller who can read but not manage the lake: %s', async (_name, run) => {
    h.canManage.value = false;
    h.findProposal.mockResolvedValue(proposalDoc(PROP));
    h.undo.mockImplementation(async () => (gated(), { entry: null, notes: [] }));
    expect((await run()).status).toBe(403);
    expect(h.createConfig).not.toHaveBeenCalled();
    expect(h.startRun).not.toHaveBeenCalled();
    expect(h.deleteConfig).not.toHaveBeenCalled();
  });

  it('builds the member context only, so an admin key on a lake it holds no grant on is refused', async () => {
    h.lakeFound.value = false;
    const res = await call(configsIndex, {});
    expect(res.status).toBe(404);
    expect(h.adminReached).not.toHaveBeenCalled();
  });

  it.each([
    ['list configs', () => call(configsIndex, { query: { id: OTHER_LAKE_ID } })],
    ['get history', () => call(configHistory, { query: { id: OTHER_LAKE_ID } })],
    ['list proposals', () => call(proposalsIndex, { query: { id: 'not-an-id' } })],
    ['get run', () => call(runOne, { query: { id: OTHER_LAKE_ID, run_id: RUN } })],
  ])('answers 404 for a foreign or malformed lake id: %s', async (_name, run) => {
    expect((await run()).status).toBe(404);
  });
});

describe('configs', () => {
  it('lists a page, mints next_cursor from the extra row, and passes it back as a keyset window', async () => {
    const rows = [1, 2, 3].map(n =>
      configDoc(`65a00000000000000000010${n}`, { createdAt: new Date(T0.getTime() - n) })
    );
    h.listConfigs.mockResolvedValueOnce(rows);

    const first = await call(configsIndex, { query: { limit: '2' } });
    expect(first.status).toBe(200);
    expect((first.body.data as unknown[]).length).toBe(2);
    expect(h.listConfigs.mock.calls[0][2]).toEqual({ limit: 3, after: undefined });
    const cursor = first.body.next_cursor as string;
    expect(typeof cursor).toBe('string');

    h.listConfigs.mockResolvedValueOnce([rows[2]]);
    const second = await call(configsIndex, { query: { limit: '2', cursor } });
    expect(second.body.next_cursor).toBeNull();
    expect(h.listConfigs.mock.calls[1][2]).toMatchObject({
      limit: 3,
      after: { createdAt: rows[1].createdAt, id: rows[1].id },
    });
  });

  it('rejects a cursor minted for another list or another lake with 422', async () => {
    const rows = [1, 2].map(n => runDoc(`65a00000000000000000020${n}`, { createdAt: new Date(T0.getTime() - n) }));
    h.listRuns.mockResolvedValueOnce(rows);
    const page = await call(runsIndex, { query: { limit: '1' } });
    const cursor = page.body.next_cursor as string;

    expect((await call(configsIndex, { query: { cursor } })).status).toBe(422);
    expect((await call(runsIndex, { query: { cursor, id: OTHER_LAKE_ID } })).status).toBe(404);
    expect((await call(runsIndex, { query: { cursor: 'garbage' } })).status).toBe(422);
  });

  it('returns each config with held computed from the live pending count', async () => {
    h.store.configs.push(configDoc(CFG, { trigger: 'periodic', cadence: 'daily', reviewBacklogLimit: 3 }));
    const res = await call(configOne, { query: { config_id: CFG } });
    expect(res.status).toBe(200);
    expect((res.body.data as { held: boolean }).held).toBe(true);
  });

  it('round-trips create, update, pause and delete', async () => {
    h.createConfig.mockImplementation(async (_lake, _actor, _grants, input: Record<string, unknown>) => {
      const doc = configDoc(CFG, { name: input.name, query: input.query, maxResults: input.maxResults ?? 10 });
      h.store.configs.push(doc);
      return doc;
    });
    h.updateConfig.mockImplementation(async (_id, _lake, _actor, _grants, input: Record<string, unknown>) => {
      const doc = h.store.configs[0];
      Object.assign(doc, { name: input.name ?? doc.name, maxResults: input.maxResults ?? doc.maxResults });
      return doc;
    });
    h.setPaused.mockImplementation(async (_id, _lake, paused: boolean) => {
      Object.assign(h.store.configs[0], { schedulePaused: paused });
      return h.store.configs[0];
    });
    h.deleteConfig.mockImplementation(async () => {
      h.store.configs.length = 0;
    });

    const created = await call(configsIndex, {
      method: 'POST',
      body: { name: 'Weekly', query: 'erosion', max_results: 7 },
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ id: CFG, name: 'Weekly', max_results: 7, schedule_paused: false });
    expect(h.createConfig.mock.calls[0][3]).toMatchObject({ name: 'Weekly', query: 'erosion', maxResults: 7 });

    const updated = await call(configOne, {
      method: 'PATCH',
      query: { config_id: CFG },
      body: { name: 'Renamed', max_results: 9 },
    });
    expect(updated.body.data).toMatchObject({ name: 'Renamed', max_results: 9 });
    expect(h.setPaused).not.toHaveBeenCalled();

    const paused = await call(configOne, {
      method: 'PATCH',
      query: { config_id: CFG },
      body: { schedule_paused: true },
    });
    expect(paused.body.data).toMatchObject({ schedule_paused: true });
    expect(h.setPaused).toHaveBeenCalledTimes(1);

    const removed = await call(configOne, { method: 'DELETE', query: { config_id: CFG } });
    expect(removed.status).toBe(204);
    expect((await call(configOne, { query: { config_id: CFG } })).status).toBe(404);
  });

  it('rejects an unknown body field and a create with no query with 422', async () => {
    expect((await call(configsIndex, { method: 'POST', body: { name: 'n', query: 'q', feedCursor: {} } })).status).toBe(
      422
    );
    expect((await call(configsIndex, { method: 'POST', body: { name: 'n' } })).status).toBe(422);
    expect(h.createConfig).not.toHaveBeenCalled();
  });

  // A percent where a fraction belongs (60 for 0.6) used to clamp to 1 and drop every result.
  it('rejects out-of-range levers with 422 on create and update instead of clamping', async () => {
    const create = await call(configsIndex, { method: 'POST', body: { name: 'n', query: 'q', min_relevance: 60 } });
    expect(create.status).toBe(422);
    expect(isZodError(create.thrown)).toBe(true);
    const update = await call(configOne, { method: 'PATCH', query: { config_id: CFG }, body: { min_relevance: 60 } });
    expect(update.status).toBe(422);
    expect(isZodError(update.thrown)).toBe(true);
    expect(h.createConfig).not.toHaveBeenCalled();
    expect(h.updateConfig).not.toHaveBeenCalled();
  });

  it.each([
    ['max_results', 0],
    ['max_results', 51],
    ['max_proposals', 26],
    ['max_proposals', 1.5],
    ['recency_days', 367],
    ['max_auto_admits', 0],
    ['cost_ceiling_micro_usd', 5_000_001],
    ['review_backlog_limit', 501],
    ['min_relevance', -0.1],
  ])('rejects %s = %s with 422', async (field, value) => {
    const res = await call(configsIndex, { method: 'POST', body: { name: 'n', query: 'q', [field]: value } });
    expect(res.status).toBe(422);
    expect(h.createConfig).not.toHaveBeenCalled();
  });

  it('answers 404 for a config of another lake', async () => {
    h.store.configs.push(configDoc(CFG, { dataLakeId: OTHER_LAKE_ID }));
    expect((await call(configOne, { query: { config_id: CFG } })).status).toBe(404);
  });
});

describe('runs', () => {
  beforeEach(() => {
    h.startRun.mockImplementation(async () => {
      const doc = runDoc(RUN);
      h.store.runs.push(doc);
      return doc;
    });
  });

  it('starts a run: 202, enqueued, and pollable through get-run', async () => {
    const started = await call(runsIndex, { method: 'POST', body: { config_id: CFG } });
    expect(started.status).toBe(202);
    expect(started.body.data).toMatchObject({ id: RUN, status: 'queued', failure_reason: null });
    expect(h.startRun.mock.calls[0][0]).toBe(CFG);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0][2]).toBe('https://sqs.example/queue');

    h.store.runs[0].status = 'failed';
    h.store.runs[0].error = 'The run could not be queued for execution. ECONNRESET 10.0.0.4';
    const polled = await call(runOne, { query: { run_id: RUN } });
    expect(polled.status).toBe(200);
    const data = polled.body.data as { status: string; failure_reason: string };
    expect(data.status).toBe('failed');
    expect(data.failure_reason).toContain('could not be queued');
    expect(JSON.stringify(polled.body)).not.toMatch(/ECONNRESET|10\.0\.0\.4/);
  });

  it('refuses to start without a queue, before any run row is written', async () => {
    h.queue.url = undefined;
    const res = await call(runsIndex, { method: 'POST', body: { config_id: CFG } });
    expect(res.status).toBe(500);
    expect(h.startRun).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('counts the start against the completion quota of an untrusted key and answers 429 when it is spent', async () => {
    h.admit.mockImplementationOnce(async (req: { apiKeyInfo?: { ownerUntrusted?: boolean } }) => {
      if (req.apiKeyInfo?.ownerUntrusted) throw new TooManyRequestsError('Daily completion quota reached');
      return { release: async () => {} };
    });
    const res = await call(runsIndex, { method: 'POST', body: { config_id: CFG }, apiKey: true });
    expect(res.status).toBe(429);
    expect(h.admit).toHaveBeenCalledWith(expect.anything(), { holdSlot: false });
    expect(h.startRun).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('answers 404 for a run of another lake or an unknown run', async () => {
    h.store.runs.push(runDoc(RUN, { dataLakeId: OTHER_LAKE_ID }));
    expect((await call(runOne, { query: { run_id: RUN } })).status).toBe(404);
    expect((await call(runOne, { query: { run_id: 'zzz' } })).status).toBe(404);
  });

  it('lists runs and rejects a limit over 100', async () => {
    h.listRuns.mockResolvedValueOnce([runDoc(RUN)]);
    const ok = await call(runsIndex, {});
    expect(ok.status).toBe(200);
    expect((ok.body.data as unknown[]).length).toBe(1);
    expect((await call(runsIndex, { query: { limit: '101' } })).status).toBe(422);
  });
});

describe('proposals', () => {
  it('lists proposals under the v1 surface, with a keyset window and no internal fields', async () => {
    h.listProposals.mockResolvedValueOnce([proposalDoc(PROP, { reviewedByUserId: 'u9' })]);
    const res = await call(proposalsIndex, { query: { status: 'pending', limit: '5' } });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/u9|canonical/);
    expect(h.listProposals).toHaveBeenCalledWith(LAKE_ID, { status: 'pending', limit: 6, after: undefined });
    expect(h.recordRead).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ surface: 'data-lake-api-v1-proposals' })
    );
  });

  it('records only the served rows as read, not the look-ahead row', async () => {
    const second = '65a0000000000000000000e2';
    h.listProposals.mockResolvedValueOnce([
      proposalDoc(PROP, { admittedFabFileId: 'served-file' }),
      proposalDoc(second, { admittedFabFileId: 'lookahead-file' }),
    ]);
    const res = await call(proposalsIndex, { query: { limit: '1' } });
    expect(res.status).toBe(200);
    expect((res.body as { data: unknown[] }).data).toHaveLength(1);
    expect(h.recordRead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fileIds: ['served-file'] }));
  });

  it('rejects a cursor minted under a different status filter with 422', async () => {
    h.listProposals.mockResolvedValueOnce([proposalDoc(PROP), proposalDoc('65a0000000000000000000e2')]);
    const page = await call(proposalsIndex, { query: { status: 'pending', limit: '1' } });
    const cursor = (page.body as { next_cursor: string }).next_cursor;
    expect(typeof cursor).toBe('string');
    expect((await call(proposalsIndex, { query: { status: 'declined', cursor } })).status).toBe(422);
    expect((await call(proposalsIndex, { query: { cursor } })).status).toBe(422);
  });

  describe('decide', () => {
    beforeEach(() => {
      h.findProposal.mockResolvedValue(proposalDoc(PROP));
    });

    it('approves and returns the admitted file', async () => {
      h.approve.mockResolvedValue({
        proposal: proposalDoc(PROP, { status: 'approved', admittedFabFileId: 'f1' }),
        fabFile: { id: 'f1', fileName: 'report.txt' },
      });
      const res = await call(proposalOne, {
        method: 'POST',
        query: { proposal_id: PROP },
        body: { decision: 'approve' },
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        data: { status: 'approved', admitted_file_id: 'f1' },
        file: { id: 'f1', file_name: 'report.txt' },
      });
    });

    it('declines with a reason, file null', async () => {
      h.decline.mockResolvedValue(proposalDoc(PROP, { status: 'declined', declineReason: 'off topic' }));
      const res = await call(proposalOne, {
        method: 'POST',
        query: { proposal_id: PROP },
        body: { decision: 'decline', reason: 'off topic' },
      });
      expect(res.body).toMatchObject({ data: { status: 'declined', decline_reason: 'off topic' }, file: null });
      expect(h.decline.mock.calls[0][2]).toEqual({ reason: 'off topic' });
    });

    it('restores, file null', async () => {
      h.restore.mockResolvedValue(proposalDoc(PROP, { status: 'pending' }));
      const res = await call(proposalOne, {
        method: 'POST',
        query: { proposal_id: PROP },
        body: { decision: 'restore' },
      });
      expect(res.body).toMatchObject({ data: { status: 'pending' }, file: null });
    });

    it('answers 404 for a malformed id, a missing proposal and another lake proposal', async () => {
      const decline = { decision: 'decline' };
      expect(
        (await call(proposalOne, { method: 'POST', query: { proposal_id: 'prop-1' }, body: decline })).status
      ).toBe(404);
      h.findProposal.mockResolvedValue(null);
      expect((await call(proposalOne, { method: 'POST', query: { proposal_id: PROP }, body: decline })).status).toBe(
        404
      );
      h.findProposal.mockResolvedValue(proposalDoc(PROP, { dataLakeId: OTHER_LAKE_ID }));
      expect((await call(proposalOne, { method: 'POST', query: { proposal_id: PROP }, body: decline })).status).toBe(
        404
      );
      expect(h.decline).not.toHaveBeenCalled();
    });
  });
});

describe('config history', () => {
  it('passes limit through and maps ids away', async () => {
    h.history.mockResolvedValue({
      lakeId: LAKE_ID,
      lakeName: 'Handbook',
      entries: [
        {
          eventId: 'ev1',
          changedAt: T0,
          principalKind: 'user',
          principalId: '65a0000000000000000000aa',
          principalName: 'Casey',
          manageRung: 'creator',
          action: 'update',
          changes: [
            { field: 'effectiveOwnerUserId', kind: 'literal', before: '65a0000000000000000000aa', after: null },
          ],
        },
      ],
      userNames: { '65a0000000000000000000aa': 'Casey' },
      truncated: false,
      windowStartsAt: T0,
      generatedAt: T0,
    });
    const res = await call(configHistory, { query: { limit: '50' } });
    expect(res.status).toBe(200);
    expect(h.history.mock.calls[0][1]).toMatchObject({ limit: 50 });
    expect(JSON.stringify(res.body)).not.toContain('65a0000000000000000000aa');
  });

  it('reads config rows only unless include=files is set', async () => {
    h.history.mockResolvedValue({
      lakeId: LAKE_ID,
      lakeName: 'Handbook',
      entries: [],
      userNames: {},
      truncated: false,
      generatedAt: T0,
    });
    await call(configHistory, { query: { limit: '5' } });
    expect(h.history.mock.calls[0][1]).toMatchObject({ includeFiles: false });
  });

  it('returns file rows when include=files is set', async () => {
    h.history.mockResolvedValue({
      lakeId: LAKE_ID,
      lakeName: 'Handbook',
      entries: [
        {
          kind: 'file',
          eventId: 'ev2',
          changedAt: T0,
          principalKind: 'user',
          principalId: '65a0000000000000000000aa',
          principalName: 'Casey',
          action: 'file-added',
          target: { kind: 'file', id: 'fab1' },
          origin: 'person',
        },
      ],
      userNames: {},
      truncated: false,
      generatedAt: T0,
    });
    const res = await call(configHistory, { query: { include: 'files' } });
    expect(res.status).toBe(200);
    expect(h.history.mock.calls[0][1]).toMatchObject({ includeFiles: true });
    expect((res.body as { data: { entries: { kind: string }[] } }).data.entries[0]?.kind).toBe('file');
  });

  it('keeps ForbiddenError for a manage-less reader', async () => {
    h.canManage.value = false;
    const res = await call(configHistory, {});
    expect(res.thrown).toBeInstanceOf(ForbiddenError);
  });
});

describe('undo a config change', () => {
  const undoRow = {
    kind: 'config',
    eventId: '65a0000000000000000000f2',
    changedAt: T0,
    principalKind: 'apiKey',
    principalId: '65a0000000000000000000aa',
    manageRung: 'creator',
    action: 'update-research-config',
    changes: [],
    undoable: true,
    undoesEventId: EVT,
  };

  it('undoes the row on the member context and maps the entry, with notes', async () => {
    h.undo.mockResolvedValue({ entry: undoRow, notes: ['Scheduled research is on hold.'] });
    const res = await call(undoChange, { method: 'POST', query: { event_id: EVT }, apiKey: true });
    expect(res.status).toBe(200);
    expect(h.undo.mock.calls[0].slice(1, 3)).toEqual([LAKE_ID, EVT]);
    expect(h.undo.mock.calls[0][3]).toMatchObject({ isAdmin: false });
    expect(res.body).toMatchObject({
      data: { kind: 'config', event_id: undoRow.eventId, undoable: true, undone_by_event_id: null },
      notes: ['Scheduled research is on hold.'],
    });
    expect(JSON.stringify(res.body)).not.toContain('65a0000000000000000000aa');
    expect(h.adminReached).not.toHaveBeenCalled();
  });

  it('returns a null entry when the History write did not persist', async () => {
    h.undo.mockResolvedValue({ entry: null, notes: [] });
    const res = await call(undoChange, { method: 'POST', query: { event_id: EVT } });
    expect(res.body).toEqual({ data: null, notes: [] });
  });

  it('keeps the 403 for a caller who can read but not manage the lake', async () => {
    h.undo.mockRejectedValue(new ForbiddenError('You do not have permission to manage this data lake'));
    const res = await call(undoChange, { method: 'POST', query: { event_id: EVT } });
    expect(res.status).toBe(403);
  });

  it('answers 404 for a foreign lake and for an unknown event', async () => {
    h.undo.mockRejectedValue(new NotFoundError('History entry not found'));
    expect((await call(undoChange, { method: 'POST', query: { event_id: EVT } })).status).toBe(404);
    h.undo.mockRejectedValue(new NotFoundError('Data lake not found'));
    expect((await call(undoChange, { method: 'POST', query: { id: OTHER_LAKE_ID, event_id: EVT } })).status).toBe(404);
  });

  it('answers 409 on a second undo', async () => {
    h.undo.mockResolvedValueOnce({ entry: null, notes: [] });
    h.undo.mockRejectedValueOnce(new ConflictError('Already undone'));
    expect((await call(undoChange, { method: 'POST', query: { event_id: EVT } })).status).toBe(200);
    const second = await call(undoChange, { method: 'POST', query: { event_id: EVT } });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: 'Already undone' });
  });

  it('declares the 403, 404 and 409 envelopes', () => {
    expect(Object.keys(undoDataLakeConfigChangeContract.responses)).toEqual(
      expect.arrayContaining(['200', '403', '404', '409', '429'])
    );
  });

  it('is capped at 120 an hour in its own bucket', () => {
    const limiter = h.rateLimitOptions.find(o => o.bucket === '/api/v1/data-lakes/[id]/config-history/undo') as
      | { limit: () => number; windowMs: number }
      | undefined;
    expect(limiter?.windowMs).toBe(60 * 60 * 1000);
    expect(limiter?.limit()).toBe(120);
  });
});
