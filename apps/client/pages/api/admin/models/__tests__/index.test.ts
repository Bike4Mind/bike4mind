// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => unknown> = [];
    const chain = async (req: { method: string }, res: unknown) => {
      for (const middleware of middlewares) await middleware(req, res, () => undefined);
      return handlers[req.method](req, res);
    };
    chain.use = (fn: (typeof middlewares)[number]) => {
      middlewares.push(fn);
      return chain;
    };
    chain.get = (fn: (typeof handlers)[string]) => {
      handlers.GET = fn;
      return chain;
    };
    return chain;
  },
}));

const h = vi.hoisted(() => ({
  catalogRows: vi.fn(async (): Promise<unknown[]> => []),
  priceRows: vi.fn(async (): Promise<unknown[]> => []),
  accessSetting: vi.fn(async (): Promise<unknown> => null),
  keys: vi.fn(async (): Promise<Record<string, string | null>> => ({})),
  settings: vi.fn(async (_name: string): Promise<unknown> => undefined),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findOne: () => h.accessSetting(), getSettingsValue: (name: string) => h.settings(name) },
  apiKeyRepository: {},
  modelCatalogRepository: { rowsInForce: () => h.catalogRows(), discoveryMilestones: async () => new Map() },
  modelDiscoveryStateRepository: { pendingSuggestions: async () => [] },
  modelPriceRepository: { rowsInForce: () => h.priceRows() },
}));
vi.mock('@bike4mind/services', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services')>()),
  apiKeyService: { getEffectiveLLMApiKeys: () => h.keys() },
}));
vi.mock('@bike4mind/services/llm/modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services/llm/modelAdmission')>()),
  loadFreeTierAllowedModels: async () => undefined,
}));
vi.mock('@server/billing/meterPlatformCompletion', () => ({ isCreditsEnforced: async () => true }));

import handler from '../index';

const ALL_KEYS = { openai: 'k', anthropic: 'k', gemini: 'k', bfl: 'k', xai: 'k', kimi: 'k', deepseek: 'k' };

const discoveredRow = (
  modelId: string,
  patch: Record<string, unknown> = {},
  effectiveFrom = '2026-07-01T00:00:00Z'
) => ({
  modelId,
  schemaVersion: 2,
  source: 'discovery',
  ownedGroups: ['identity', 'limits', 'lifecycle', 'availability', 'dispatch'],
  patch: {
    id: modelId,
    vendor: 'openai',
    backend: 'openai',
    type: 'text',
    name: modelId,
    contextWindow: 200_000,
    adapterFamily: 'openai-chat',
    dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'chat' },
    lifecycle: { status: 'discovered' },
    autoDisabled: true,
    autoDisabledReason: 'discovered, awaiting price',
    ...patch,
  },
  effectiveFrom: new Date(effectiveFrom),
});

const foundationRow = discoveredRow('anthropic.claude-admin-list-v1:0', {
  vendor: 'anthropic',
  backend: 'bedrock',
  lifecycle: { status: 'active' },
  autoDisabled: false,
  autoDisabledReason: undefined,
  disabled: true,
  disabledReason: 'not invocable on demand; use its region-prefixed inference profile id',
});

interface ListBody {
  models: Array<{
    id: string;
    status: string;
    reasons: Array<{ code: string; fixAction?: string }>;
    sunsetDate: string | null;
    sunsetDays: number | null;
  }>;
  total: number;
  counts: Record<string, number>;
  foundationIds: number;
}

async function list(
  query: Record<string, string | string[]> = {},
  user: Record<string, unknown> = { isAdmin: true }
): Promise<ListBody> {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as unknown as { user: Record<string, unknown> }).user = { id: 'admin-1', ...user };
  await (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res);
  expect(res._getStatusCode()).toBe(200);
  return res._getJSONData() as ListBody;
}

const failure = (query: Record<string, string | string[]>, user: Record<string, unknown> = { isAdmin: true }) =>
  list(query, user).catch((error: { statusCode: number; message: string }) => error);

describe('GET /api/admin/models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.catalogRows.mockResolvedValue([discoveredRow('gpt-admin-list'), foundationRow]);
    h.priceRows.mockResolvedValue([]);
    h.accessSetting.mockResolvedValue(null);
    h.keys.mockResolvedValue(ALL_KEYS);
    h.settings.mockImplementation(async name => (name === 'modelDiscoveryMode' ? 'write' : undefined));
  });

  it('refuses a user without admin access, and serves a support:read delegate', async () => {
    expect(await failure({}, { isAdmin: false })).toMatchObject({
      message: expect.stringMatching(/missing permission/i),
    });
    expect((await list({ view: 'needs-review' }, { isAdmin: false, adminPermissions: ['support:read'] })).total).toBe(
      1
    );
  });

  it('lists adapter literals and catalog-only models, leaving profile-only foundation ids to the chip', async () => {
    const body = await list({ pageSize: '500' });
    const ids = body.models.map(model => model.id);

    expect(ids).toContain('gpt-admin-list');
    expect(ids).toContain('gpt-image-2');
    expect(ids).not.toContain('anthropic.claude-admin-list-v1:0');
    expect(body.foundationIds).toBe(1);
    expect(body.counts['needs-review']).toBeGreaterThanOrEqual(1);

    const restored = await list({ view: 'hidden', showFoundationIds: 'true', providers: 'bedrock' });
    expect(restored.models.map(model => model.id)).toContain('anthropic.claude-admin-list-v1:0');
  });

  it('shows a price and a promotion on the very next fetch', async () => {
    const reasons = async () =>
      (await list({ search: 'gpt-admin-list' })).models.find(model => model.id === 'gpt-admin-list')?.reasons;
    expect(await reasons()).toEqual([expect.objectContaining({ code: 'price-none', fixAction: 'add-price' })]);

    h.priceRows.mockResolvedValue([
      {
        modelId: 'gpt-admin-list',
        unit: 'per_token',
        pricing: { '0': { input: 1e-6, output: 4e-6 } },
        effectiveFrom: new Date('2026-07-02T00:00:00Z'),
        createdAt: new Date('2026-07-02T00:00:00Z'),
        updatedAt: new Date('2026-07-02T00:00:00Z'),
      },
    ]);
    expect(await reasons()).toEqual([
      expect.objectContaining({ code: 'awaiting-discovery-run', fixAction: 'run-discovery' }),
    ]);

    h.catalogRows.mockResolvedValue([
      discoveredRow('gpt-admin-list'),
      discoveredRow(
        'gpt-admin-list',
        { lifecycle: { status: 'active' }, autoDisabled: false, autoDisabledReason: undefined },
        '2026-07-03T00:00:00Z'
      ),
    ]);
    const listed = (await list({ view: 'listed', search: 'gpt-admin-list' })).models;
    expect(listed).toEqual([expect.objectContaining({ id: 'gpt-admin-list', status: 'listed', reasons: [] })]);
  });

  it('words a priced model for the discovery mode it waits on', async () => {
    h.priceRows.mockResolvedValue([
      {
        modelId: 'gpt-admin-list',
        unit: 'per_token',
        pricing: { '0': { input: 1e-6, output: 4e-6 } },
        effectiveFrom: new Date('2026-07-02T00:00:00Z'),
        createdAt: new Date('2026-07-02T00:00:00Z'),
        updatedAt: new Date('2026-07-02T00:00:00Z'),
      },
    ]);
    const reasons = async () =>
      (await list({ search: 'gpt-admin-list' })).models.find(model => model.id === 'gpt-admin-list')?.reasons;

    h.settings.mockImplementation(async () => undefined);
    expect(await reasons()).toEqual([
      {
        code: 'awaiting-discovery-run',
        message: 'Priced. Discovery only reports right now, so it lists after a run in write mode.',
      },
    ]);

    h.settings.mockImplementation(async name => (name === 'enableModelDiscovery' ? false : 'write'));
    expect(await reasons()).toEqual([
      {
        code: 'awaiting-discovery-run',
        message: 'Priced. Model discovery is off, so it lists after a run in write mode.',
      },
    ]);
  });

  it('reads the access entries an admin saved', async () => {
    h.accessSetting.mockResolvedValue({
      settingValue: [{ id: 'gpt-image-2', enabled: false, allowedUserTags: [], allowedEntitlements: [] }],
    });
    const image = (await list({ search: 'gpt-image-2' })).models.find(model => model.id === 'gpt-image-2');

    expect(image?.status).toBe('hidden');
    expect(image?.reasons).toEqual([expect.objectContaining({ code: 'admin-off', fixAction: 'turn-on' })]);
  });

  it('reports a backend with no key in this environment', async () => {
    h.keys.mockResolvedValue({ ...ALL_KEYS, xai: null });
    const xai = (await list({ providers: 'xai', pageSize: '500' })).models;

    expect(xai.length).toBeGreaterThan(0);
    // A sunset date that has passed outranks every reason: those read Retired.
    for (const model of xai) {
      expect(['hidden', 'retired']).toContain(model.status);
      expect(model.reasons.map(reason => reason.code)).toContain('no-credential-for-backend');
    }
    expect(xai.some(model => model.status === 'hidden')).toBe(true);
  });

  it('sorts by the sooner lifecycle date, undated models last', async () => {
    h.catalogRows.mockResolvedValue([
      discoveredRow('gpt-admin-list'),
      discoveredRow('gpt-admin-dated', {
        lifecycle: { status: 'active', retirementDate: '2099-01-01' },
        autoDisabled: false,
        autoDisabledReason: undefined,
      }),
    ]);
    const models = (await list({ sort: 'sunset', pageSize: '500' })).models;
    const days = models.map(model => model.sunsetDays);
    const dated = days.filter((value): value is number => value !== null);

    expect(models.find(model => model.id === 'gpt-admin-dated')?.sunsetDate).toBe('2099-01-01');
    expect(days).toEqual([...dated].sort((a, b) => a - b).concat(days.filter(value => value === null)));
  });

  it.each([
    [{ view: 'nope' }],
    [{ view: ['listed', 'hidden'] }],
    [{ sort: 'price' }],
    [{ page: '0' }],
    [{ pageSize: '501' }],
    [{ showFoundationIds: 'yes' }],
    [{ sources: 'vendor' }],
  ])('answers 400 to %j', async query => {
    expect(await failure(query)).toMatchObject({ statusCode: 400 });
  });
});
