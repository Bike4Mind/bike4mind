import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

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

const mockRowsInForce = vi.fn();
const mockAppend = vi.fn();
const mockFindByModelId = vi.fn();
const mockPendingSuggestions = vi.fn();
const mockResolveSuggestion = vi.fn();
vi.mock('@bike4mind/database', () => ({
  modelCatalogRepository: {
    rowsInForce: (...a: unknown[]) => mockRowsInForce(...a),
    append: (...a: unknown[]) => mockAppend(...a),
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
}));

import handler from '../model-deprecation-status';

const LIVE_MODEL = { id: 'gpt-live', name: 'Live', backend: 'openai' };

const catalogRow = (modelId: string, lifecycle: Record<string, string>) => ({
  modelId,
  schemaVersion: 1,
  source: 'discovery',
  ownedGroups: ['lifecycle'],
  patch: { lifecycle },
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

  it('populates the EXPIRED view from catalog lifecycle, which the picker filter hides', async () => {
    const { res, run } = call({ method: 'GET' });
    await run();
    // gpt-sunset never appears in getAvailableModels, which is exactly why the
    // pre-catalog version of this endpoint could not report it.
    expect(res._getJSONData().expired).toEqual([
      expect.objectContaining({ modelId: 'gpt-sunset', status: 'deprecated', deprecationDate: '2026-01-01' }),
    ]);
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
    const { run } = call({
      method: 'POST',
      body: { modelId: 'gpt-sunset', action: 'accept', note: 'operator pick', replacedBy: 'gpt-newer' },
    });
    await run();
    expect(mockAppend.mock.calls[0][0].patch.lifecycle.replacedBy).toBe('gpt-newer');
  });

  it('dismiss records the verdict and writes no catalog row', async () => {
    const { res, run } = call({ method: 'POST', body: { modelId: 'gpt-sunset', action: 'dismiss' } });
    await run();
    expect(mockResolveSuggestion).toHaveBeenCalledWith('gpt-sunset', 'dismissed');
    expect(mockAppend).not.toHaveBeenCalled();
    expect(res._getJSONData().state).toMatchObject({ modelId: 'gpt-sunset' });
  });
});
