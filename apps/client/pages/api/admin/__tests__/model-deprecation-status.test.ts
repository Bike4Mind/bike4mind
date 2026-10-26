// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { CATALOG_SCHEMA_VERSION, ModelCatalogRowInput } from '@bike4mind/common';
import type { IModelCatalogRow } from '@bike4mind/common';
import { resolveCatalogRecords } from '@bike4mind/llm-adapters';

// Middleware stripped so the handler body runs directly (same pattern as
// __tests__/model-prices.test.ts). The chain object doubles as the exported
// handler and dispatches on req.method.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const chain = async (req: { method: string }, res: unknown) => handlers[req.method](req, res);
    chain.use = () => chain;
    chain.get = (fn: (typeof handlers)[string]) => {
      handlers.GET = fn;
      return chain;
    };
    chain.post = (fn: (typeof handlers)[string]) => {
      handlers.POST = fn;
      return chain;
    };
    return chain;
  },
}));

const mockAudit = vi.hoisted(() => vi.fn(async () => null));
const mockRowsInForce = vi.fn();
const mockAppend = vi.fn();
const mockFindByModelId = vi.fn();
const mockPendingSuggestions = vi.fn();
const mockResolveSuggestion = vi.fn();
const mockPriceRowsInForce = vi.fn();
vi.mock('@bike4mind/database', () => ({
  whenCatalogSeeded: async () => true,
  apiKeyRepository: {},
  adminSettingsRepository: {
    getSettingsValue: async (key: string) =>
      key === 'orchestrationDefaults' ? { fallbackModels: [], intentClassifier: { enabled: false } } : '',
  },
  modelCatalogRepository: {
    rowsInForce: (...a: unknown[]) => mockRowsInForce(...a),
    append: (...a: unknown[]) => mockAppend(...a),
  },
  modelPriceRepository: {
    rowsInForce: (...a: unknown[]) => mockPriceRowsInForce(...a),
  },
  modelDiscoveryStateRepository: {
    findByModelId: (...a: unknown[]) => mockFindByModelId(...a),
    pendingSuggestions: (...a: unknown[]) => mockPendingSuggestions(...a),
    resolveSuggestion: (...a: unknown[]) => mockResolveSuggestion(...a),
  },
}));

// Only the model list is stubbed; the lifecycle/stale-reference helpers are the
// real ones, so this test covers the wiring end to end.
const mockGetAvailableModels = vi.fn();
vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/llm-adapters')>();
  return { ...actual, getAvailableModels: (...a: unknown[]) => mockGetAvailableModels(...a) };
});

vi.mock('@bike4mind/utils', () => ({
  FALLBACK_PREFERENCES: { 'gpt-live': ['gpt-sunset', 'gpt-live'] },
  DEFAULT_FALLBACK_CHAIN: ['gpt-live'],
  getSettingsByNames: vi.fn(),
}));

vi.mock('@bike4mind/services', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services')>()),
  apiKeyService: { getEffectiveLLMApiKeys: async () => ({}) },
}));

vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: mockAudit }));

import handler from '../model-deprecation-status';

const LIVE_MODEL = { id: 'gpt-live', name: 'Live', backend: 'openai' };

const catalogRow = (
  modelId: string,
  lifecycle: NonNullable<IModelCatalogRow['patch']['lifecycle']>
): IModelCatalogRow => ({
  modelId,
  schemaVersion: CATALOG_SCHEMA_VERSION,
  source: 'discovery',
  ownedGroups: ['lifecycle'],
  patch: { lifecycle },
  effectiveFrom: new Date('2026-07-01T00:00:00Z'),
});

// The cost clause fails closed, so an accept only gets past it when both sides
// carry a per-token row: these are what make the happy paths happy.
const priceRow = (modelId: string, input: number, output: number) => ({
  modelId,
  unit: 'per_token',
  pricing: { '0': { input, output } },
  effectiveFrom: new Date('2026-07-01T00:00:00Z'),
});

const SUGGESTION = {
  status: 'deprecated',
  deprecationDate: '2026-08-01',
  replacedBy: 'gpt-live',
  source: 'anthropic-docs',
  suggestedAt: new Date('2026-07-20T00:00:00Z'),
};

function call(options: { method: 'GET' | 'POST'; isAdmin?: boolean; query?: object; body?: object }) {
  const { req, res } = createMocks({ method: options.method, query: options.query ?? {}, body: options.body });
  (req as unknown as { user: { isAdmin: boolean; id: string } }).user = {
    isAdmin: options.isAdmin ?? true,
    id: 'admin-1',
  };
  return { req, res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAvailableModels.mockResolvedValue([LIVE_MODEL]);
  mockRowsInForce.mockResolvedValue([
    catalogRow('gpt-live', { status: 'active' }),
    catalogRow('gpt-sunset', { status: 'deprecated', deprecationDate: '2026-01-01' }),
  ]);
  mockPriceRowsInForce.mockResolvedValue([priceRow('gpt-sunset', 2e-6, 8e-6), priceRow('gpt-live', 1e-6, 4e-6)]);
  mockPendingSuggestions.mockResolvedValue([{ modelId: 'gpt-sunset', suggestion: SUGGESTION }]);
  mockFindByModelId.mockResolvedValue({ modelId: 'gpt-sunset', suggestion: SUGGESTION });
  mockResolveSuggestion.mockResolvedValue({ modelId: 'gpt-sunset' });
  mockAppend.mockResolvedValue({ id: 'row1' });
});

describe('GET /api/admin/model-deprecation-status', () => {
  it('rejects non-admin users', async () => {
    const { run } = call({ method: 'GET', isAdmin: false });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockRowsInForce).not.toHaveBeenCalled();
  });

  it('keeps the original keys and adds the queue, the expired view and the stale references', async () => {
    const { res, run } = call({ method: 'GET', query: { daysAhead: '30' } });
    await run();
    const body = res._getJSONData();

    expect(body).toMatchObject({ daysAhead: 30, totalModels: 1 });
    expect(body.expiringOrExpired).toEqual([]);
    expect(body.queue).toEqual([
      { modelId: 'gpt-sunset', suggestion: expect.objectContaining({ replacedBy: 'gpt-live' }) },
    ]);
  });

  it('still serves the rest of the report when the stale reference report fails', async () => {
    mockGetAvailableModels.mockResolvedValueOnce([LIVE_MODEL]).mockRejectedValueOnce(new Error('provider down'));
    const { res, run } = call({ method: 'GET' });
    await run();
    const body = res._getJSONData();

    expect(res._getStatusCode()).toBe(200);
    expect(body.staleReferences).toBeNull();
    expect(body.staleReferencesError).toEqual(expect.any(String));
    expect(body).toMatchObject({ totalModels: 1 });
    expect(body.queue).toHaveLength(1);
  });

  it('populates the EXPIRED view from catalog lifecycle, which the picker filter hides', async () => {
    const { res, run } = call({ method: 'GET' });
    await run();
    // gpt-sunset never appears in getAvailableModels, which is exactly why the
    // pre-catalog version of this endpoint could not report it.
    expect(res._getJSONData().expired).toEqual([
      expect.objectContaining({ modelId: 'gpt-sunset', status: 'deprecated', deprecationDate: '2026-01-01' }),
    ]);
  });

  it('exposes legacy active dates for review even when the model list omits the model', async () => {
    mockRowsInForce.mockResolvedValue([
      catalogRow('future-active', { status: 'active', deprecationDate: '2099-01-01' }),
      catalogRow('past-active', { status: 'active', deprecationDate: '2020-01-01' }),
      catalogRow('retired', { status: 'retired', deprecationDate: '2019-01-01' }),
      catalogRow('undated', { status: 'active' }),
    ]);
    const { res, run } = call({ method: 'GET' });
    await run();
    expect(res._getJSONData().activeModelDates).toEqual([
      { modelId: 'past-active', deprecationDate: '2020-01-01' },
      { modelId: 'future-active', deprecationDate: '2099-01-01' },
    ]);
  });

  // Rates for every priced model, not just the queue's: the accept modal prices
  // whatever successor the operator types over the suggestion.
  it('publishes the rates in force per MTok so the queue can price a successor', async () => {
    const { res, run } = call({ method: 'GET' });
    await run();

    expect(res._getJSONData().perMTokRates).toEqual({
      'gpt-sunset': { input: 2, output: 8 },
      'gpt-live': { input: 1, output: 4 },
    });
  });

  it('omits a model whose only price row is not per-token, rather than mispricing it', async () => {
    mockPriceRowsInForce.mockResolvedValue([
      priceRow('gpt-live', 1e-6, 4e-6),
      { ...priceRow('gpt-sunset', 2e-6, 8e-6), unit: 'per_image' },
    ]);
    const { res, run } = call({ method: 'GET' });
    await run();

    expect(res._getJSONData().perMTokRates).toEqual({ 'gpt-live': { input: 1, output: 4 } });
  });

  it('reports a fallback chain pointing at a deprecated model', async () => {
    const { res, run } = call({ method: 'GET' });
    await run();
    expect(res._getJSONData().staleReferences).toContainEqual({
      surface: 'fallback-chain',
      key: 'gpt-live',
      referencedId: 'gpt-sunset',
      problem: 'deprecated',
    });
  });
});

describe('POST /api/admin/model-deprecation-status', () => {
  it('rejects non-admin users', async () => {
    const { run } = call({ method: 'POST', isAdmin: false, body: { modelId: 'gpt-sunset', action: 'dismiss' } });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockResolveSuggestion).not.toHaveBeenCalled();
  });

  it('accept appends an operator lifecycle row carrying the suggestion, then records the verdict', async () => {
    const { run } = call({
      method: 'POST',
      body: { modelId: 'gpt-sunset', action: 'accept', note: 'anthropic deprecation page 2026-07' },
    });
    await run();

    expect(mockAppend).toHaveBeenCalledTimes(1);
    const row = mockAppend.mock.calls[0][0];
    expect(row).toMatchObject({
      modelId: 'gpt-sunset',
      source: 'operator',
      ownedGroups: ['lifecycle'],
      note: 'anthropic deprecation page 2026-07',
      patch: { lifecycle: { status: 'deprecated', deprecationDate: '2026-08-01', replacedBy: 'gpt-live' } },
      contributors: [{ group: 'lifecycle', source: 'admin-1' }],
    });
    expect(row.effectiveFrom).toBeInstanceOf(Date);
    expect(mockResolveSuggestion).toHaveBeenCalledWith('gpt-sunset', 'accepted');
  });

  it('keeps the lifecycle fields a remap-only suggestion says nothing about', async () => {
    // The operator row owns the whole group and the merge swaps it wholesale, so
    // dropping the date here would un-hide the model.
    mockFindByModelId.mockResolvedValue({
      modelId: 'gpt-sunset',
      suggestion: { replacedBy: 'gpt-live', source: 'anthropic-docs', suggestedAt: new Date() },
    });
    const { run } = call({
      method: 'POST',
      body: { modelId: 'gpt-sunset', action: 'accept', note: 'successor confirmed' },
    });
    await run();

    expect(mockAppend.mock.calls[0][0].patch.lifecycle).toEqual({
      status: 'deprecated',
      deprecationDate: '2026-01-01',
      replacedBy: 'gpt-live',
    });
  });

  it('records only the date when accepting a date-only aggregator suggestion', async () => {
    // The planner stamps 'active' on these; a status-less row would fall back to
    // 'deprecated' and hide the model the moment the operator accepts.
    mockFindByModelId.mockResolvedValue({
      modelId: 'gpt-live',
      suggestion: { status: 'active', deprecationDate: '2099-08-01', source: 'litellm', suggestedAt: new Date() },
    });
    const { run } = call({
      method: 'POST',
      body: { modelId: 'gpt-live', action: 'accept', note: 'litellm announced a sunset date' },
    });
    await run();

    expect(mockAppend.mock.calls[0][0].patch.lifecycle).toMatchObject({
      status: 'active',
      deprecationDate: '2099-08-01',
    });
    expect(mockResolveSuggestion).toHaveBeenCalledWith('gpt-live', 'accepted');
  });

  it.each([true, false])(
    'preserves superseded metadata (%s) through acceptance and catalog merge',
    async isSuperseded => {
      const rows: IModelCatalogRow[] = [
        catalogRow('gpt-live', { status: 'active' }),
        { ...catalogRow('gpt-sunset', { status: 'active', isSuperseded: true }), source: 'seed' },
        ...(!isSuperseded
          ? [
              {
                ...catalogRow('gpt-sunset', { status: 'active', isSuperseded: false }),
                source: 'operator',
                effectiveFrom: new Date('2026-07-02T00:00:00Z'),
              },
            ]
          : []),
      ];
      mockRowsInForce.mockResolvedValue(rows);
      mockFindByModelId.mockResolvedValue({
        modelId: 'gpt-sunset',
        suggestion: { ...SUGGESTION, deprecationDate: '2099-08-01' },
      });
      const { run } = call({
        method: 'POST',
        body: { modelId: 'gpt-sunset', action: 'accept', note: 'future deprecation confirmed' },
      });
      await run();

      expect(mockAppend).toHaveBeenCalledOnce();
      const appended = ModelCatalogRowInput.parse(mockAppend.mock.calls[0][0]);
      const merged = resolveCatalogRecords([...rows, { ...appended, schemaVersion: CATALOG_SCHEMA_VERSION }]);
      expect(merged.get('gpt-sunset')?.record.lifecycle).toMatchObject({
        status: 'deprecated',
        deprecationDate: '2099-08-01',
        isSuperseded,
      });
    }
  );

  it('lets the suggestion date win over the one already in force', async () => {
    const { run } = call({
      method: 'POST',
      body: { modelId: 'gpt-sunset', action: 'accept', note: 'anthropic deprecation page 2026-07' },
    });
    await run();

    // The catalog carries 2026-01-01; the suggestion is the newer evidence.
    expect(mockAppend.mock.calls[0][0].patch.lifecycle.deprecationDate).toBe('2026-08-01');
  });

  it('rejects a suggestion whose date is not a calendar date', async () => {
    mockFindByModelId.mockResolvedValue({
      modelId: 'gpt-sunset',
      suggestion: { ...SUGGESTION, deprecationDate: 'early 2027' },
    });
    const { run } = call({
      method: 'POST',
      body: { modelId: 'gpt-sunset', action: 'accept', note: 'parsed from the deprecations page' },
    });

    await expect(run()).rejects.toThrow(/not a YYYY-MM-DD calendar date/);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('rejects an accept without a note (the note IS the audit trail)', async () => {
    const { run } = call({ method: 'POST', body: { modelId: 'gpt-sunset', action: 'accept', note: '   ' } });
    await expect(run()).rejects.toThrow(/note/i);
    expect(mockAppend).not.toHaveBeenCalled();
    expect(mockResolveSuggestion).not.toHaveBeenCalled();
  });

  it('rejects a model with no suggestion to settle', async () => {
    mockFindByModelId.mockResolvedValue(null);
    const { run } = call({ method: 'POST', body: { modelId: 'ghost', action: 'dismiss' } });
    await expect(run()).rejects.toThrow(/no lifecycle suggestion/);
  });

  it('refuses to settle a suggestion an operator already resolved', async () => {
    mockFindByModelId.mockResolvedValue({
      modelId: 'gpt-sunset',
      suggestion: { ...SUGGESTION, resolution: 'dismissed' },
    });
    const { run } = call({ method: 'POST', body: { modelId: 'gpt-sunset', action: 'accept', note: 'again' } });
    await expect(run()).rejects.toThrow(/already dismissed/);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('rejects a replacedBy override the live list does not know', async () => {
    const { run } = call({
      method: 'POST',
      body: { modelId: 'gpt-sunset', action: 'accept', note: 'operator pick', replacedBy: 'gpt-typo' },
    });
    await expect(run()).rejects.toThrow(/unknown to the merged model list/);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('rejects a replacedBy override that is itself sunsetting', async () => {
    mockGetAvailableModels.mockResolvedValue([LIVE_MODEL, { id: 'gpt-sunset' }]);
    const { run } = call({
      method: 'POST',
      body: { modelId: 'gpt-live', action: 'accept', note: 'operator pick', replacedBy: 'gpt-sunset' },
    });
    await expect(run()).rejects.toThrow(/is deprecated and cannot replace/);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('accepts a successor the catalog holds as active even when no API key lists it', async () => {
    // getAvailableModels(null) is credential-gated, so on a hosted deploy most
    // models are absent from it; the catalog is what proves the successor exists.
    mockGetAvailableModels.mockResolvedValue([]);
    mockRowsInForce.mockResolvedValue([
      catalogRow('gpt-live', { status: 'active' }),
      catalogRow('gpt-sunset', { status: 'deprecated', deprecationDate: '2026-01-01' }),
    ]);
    const { run } = call({
      method: 'POST',
      body: { modelId: 'gpt-sunset', action: 'accept', note: 'keyless deploy' },
    });
    await run();
    expect(mockAppend.mock.calls[0][0].patch.lifecycle.replacedBy).toBe('gpt-live');
  });

  it('writes an accepted override in place of the suggested successor', async () => {
    mockGetAvailableModels.mockResolvedValue([LIVE_MODEL, { id: 'gpt-newer' }]);
    mockRowsInForce.mockResolvedValue([
      catalogRow('gpt-live', { status: 'active' }),
      catalogRow('gpt-newer', { status: 'active' }),
      catalogRow('gpt-sunset', { status: 'deprecated', deprecationDate: '2026-01-01' }),
    ]);
    mockPriceRowsInForce.mockResolvedValue([priceRow('gpt-sunset', 2e-6, 8e-6), priceRow('gpt-newer', 1e-6, 4e-6)]);
    const { run } = call({
      method: 'POST',
      body: { modelId: 'gpt-sunset', action: 'accept', note: 'operator pick', replacedBy: 'gpt-newer' },
    });
    await run();
    expect(mockAppend.mock.calls[0][0].patch.lifecycle.replacedBy).toBe('gpt-newer');
    // Nothing was overruled, so the note is exactly what the operator wrote.
    expect(mockAppend.mock.calls[0][0].note).toBe('operator pick');
  });

  it('answers 409 with the clauses the automation would have refused the successor on', async () => {
    // The successor is more expensive: a clause the accept path had no analogue
    // for, so this row used to go straight in as a sovereign operator row.
    mockPriceRowsInForce.mockResolvedValue([priceRow('gpt-sunset', 1e-6, 4e-6), priceRow('gpt-live', 9e-6, 9e-6)]);
    const { res, run } = call({
      method: 'POST',
      body: { modelId: 'gpt-sunset', action: 'accept', note: 'looks right to me' },
    });
    await run();

    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toMatchObject({
      code: 'replacement-blocked',
      modelId: 'gpt-sunset',
      replacedBy: 'gpt-live',
      blockers: ['cost-not-lower'],
    });
    expect(res._getJSONData().details[0]).toMatch(/costs more/);
    expect(mockAppend).not.toHaveBeenCalled();
    expect(mockResolveSuggestion).not.toHaveBeenCalled();
  });

  it('409s on a successor with no comparable price, because unverifiable is not verified', async () => {
    mockPriceRowsInForce.mockResolvedValue([priceRow('gpt-sunset', 2e-6, 8e-6)]);
    const { res, run } = call({
      method: 'POST',
      body: { modelId: 'gpt-sunset', action: 'accept', note: 'looks right to me' },
    });
    await run();

    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData().blockers).toEqual(['cost-unverifiable']);
  });

  it('appends once the operator acknowledges the blockers, recording them in the note', async () => {
    mockPriceRowsInForce.mockResolvedValue([priceRow('gpt-sunset', 1e-6, 4e-6), priceRow('gpt-live', 9e-6, 9e-6)]);
    const { res, run } = call({
      method: 'POST',
      body: {
        modelId: 'gpt-sunset',
        action: 'accept',
        note: 'billing signed off on the increase',
        acknowledgeBlockers: true,
      },
    });
    await run();

    expect(res._getStatusCode()).toBe(200);
    expect(mockAppend).toHaveBeenCalledTimes(1);
    // The override is only auditable if the row says what it overruled.
    expect(mockAppend.mock.calls[0][0].note).toBe(
      'billing signed off on the increase [override; acknowledged blockers: cost-not-lower]'
    );
    expect(mockAppend.mock.calls[0][0].patch.lifecycle.replacedBy).toBe('gpt-live');
    expect(mockResolveSuggestion).toHaveBeenCalledWith('gpt-sunset', 'accepted');
  });

  it('409s on a successor the catalog does not hold, even though the live list does', async () => {
    mockGetAvailableModels.mockResolvedValue([LIVE_MODEL, { id: 'gpt-ghost' }]);
    const { res, run } = call({
      method: 'POST',
      body: { modelId: 'gpt-sunset', action: 'accept', note: 'operator pick', replacedBy: 'gpt-ghost' },
    });
    await run();

    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData().blockers).toEqual(['unknown-model']);
  });

  it('leaves a clean accept at 200 with no blocker bookkeeping', async () => {
    const { res, run } = call({
      method: 'POST',
      body: { modelId: 'gpt-sunset', action: 'accept', note: 'anthropic deprecation page 2026-07' },
    });
    await run();

    expect(res._getStatusCode()).toBe(200);
    expect(mockAppend.mock.calls[0][0].note).toBe('anthropic deprecation page 2026-07');
  });

  it('dismiss records the verdict and writes no catalog row', async () => {
    const { res, run } = call({ method: 'POST', body: { modelId: 'gpt-sunset', action: 'dismiss' } });
    await run();
    expect(mockResolveSuggestion).toHaveBeenCalledWith('gpt-sunset', 'dismissed');
    expect(mockAppend).not.toHaveBeenCalled();
    expect(res._getJSONData().state).toMatchObject({ modelId: 'gpt-sunset' });
  });
});

describe('POST /api/admin/model-deprecation-status admin audit', () => {
  it('records an accepted suggestion with the lifecycle it applied', async () => {
    await call({
      method: 'POST',
      body: { modelId: 'gpt-sunset', action: 'accept', note: 'anthropic deprecation page 2026-07' },
    }).run();

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'settings.model_lifecycle.suggestion_resolved',
      target: { kind: 'settings', id: 'gpt-sunset' },
      details: { resolution: 'accept', status: 'deprecated', replacedBy: 'gpt-live' },
    });
    expect(mockResolveSuggestion.mock.invocationCallOrder[0]).toBeLessThan(mockAudit.mock.invocationCallOrder[0]);
  });

  it('records a dismissed suggestion', async () => {
    await call({ method: 'POST', body: { modelId: 'gpt-sunset', action: 'dismiss' } }).run();

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][1]).toMatchObject({
      action: 'settings.model_lifecycle.suggestion_resolved',
      target: { kind: 'settings', id: 'gpt-sunset' },
      details: { resolution: 'dismiss' },
    });
  });

  it('does not audit a request that answers 409 with blockers', async () => {
    mockPriceRowsInForce.mockResolvedValue([priceRow('gpt-sunset', 1e-6, 4e-6), priceRow('gpt-live', 9e-6, 9e-6)]);
    const { res, run } = call({
      method: 'POST',
      body: { modelId: 'gpt-sunset', action: 'accept', note: 'n' },
    });
    await run();

    expect(res._getStatusCode()).toBe(409);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
