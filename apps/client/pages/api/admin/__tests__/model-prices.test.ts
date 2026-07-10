import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Middleware stripped so the handler body runs directly (same pattern as
// pages/api/email/__tests__/verify.test.ts). The chain object doubles as the
// exported handler and dispatches on req.method.
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
const mockHistoryForModel = vi.fn();
const mockAppend = vi.fn();
const mockGenerateSeed = vi.fn();
vi.mock('@bike4mind/database', () => ({
  modelPriceRepository: {
    rowsInForce: (...a: unknown[]) => mockRowsInForce(...a),
    historyForModel: (...a: unknown[]) => mockHistoryForModel(...a),
    append: (...a: unknown[]) => mockAppend(...a),
  },
  generateModelPriceSeed: (...a: unknown[]) => mockGenerateSeed(...a),
  SEED_NOTE: 'adapter-seed',
}));

import handler from '../model-prices';

const TIER = { input: 4e-6, output: 16e-6 };

function call(options: { method: 'GET' | 'POST'; isAdmin?: boolean; query?: object; body?: object }) {
  const { req, res } = createMocks({ method: options.method, query: options.query ?? {}, body: options.body });
  (req as unknown as { user: { isAdmin: boolean } }).user = { isAdmin: options.isAdmin ?? true };
  return { req, res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('GET /api/admin/model-prices', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects non-admin users', async () => {
    const { run } = call({ method: 'GET', isAdmin: false });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockRowsInForce).not.toHaveBeenCalled();
  });

  it('returns the rows in force', async () => {
    mockRowsInForce.mockResolvedValue([{ modelId: 'gpt-x', unit: 'per_token', pricing: { '0': TIER } }]);
    const { res, run } = call({ method: 'GET' });
    await run();
    expect(res._getJSONData().rows).toHaveLength(1);
  });

  it('returns per-model history when requested', async () => {
    mockHistoryForModel.mockResolvedValue([{ modelId: 'gpt-x', note: 'manual reprice' }]);
    const { res, run } = call({ method: 'GET', query: { history: 'gpt-x' } });
    await run();
    expect(mockHistoryForModel).toHaveBeenCalledWith('gpt-x');
    expect(res._getJSONData().history).toHaveLength(1);
  });
});

describe('POST /api/admin/model-prices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppend.mockResolvedValue({ id: 'row1' });
    // gpt-x is a known (seeded) model with no prior operator rows by default.
    mockGenerateSeed.mockResolvedValue([{ modelId: 'gpt-x', unit: 'per_token', pricing: { '0': TIER } }]);
    mockRowsInForce.mockResolvedValue([]);
  });

  it('appends an operator reprice with a server-side effectiveFrom', async () => {
    const { run } = call({
      method: 'POST',
      body: { modelId: 'gpt-x', unit: 'per_token', pricing: { '0': TIER }, note: 'provider price page 2026-07' },
    });
    await run();
    expect(mockAppend).toHaveBeenCalledTimes(1);
    const row = mockAppend.mock.calls[0][0];
    expect(row).toMatchObject({ modelId: 'gpt-x', note: 'provider price page 2026-07' });
    expect(row.effectiveFrom).toBeInstanceOf(Date);
  });

  it('rejects a reprice for a model unknown to the catalog and the seed (typo protection)', async () => {
    const { run } = call({
      method: 'POST',
      body: { modelId: 'gpt-5-minl', unit: 'per_token', pricing: { '0': TIER }, note: 'typo reprice' },
    });
    await expect(run()).rejects.toThrow(/unknown model/i);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('rejects unknown tier rate fields instead of silently stripping them (audio_* before the tier schema learns them)', async () => {
    const { run } = call({
      method: 'POST',
      body: {
        modelId: 'gpt-x',
        unit: 'per_token',
        pricing: { '0': { ...TIER, audio_inputt: 32e-6 } },
        note: 'invoice',
      },
    });
    await expect(run()).rejects.toThrow();
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('rejects an all-zero reprice as a 400-class validation error, not a 500', async () => {
    const { run } = call({
      method: 'POST',
      body: { modelId: 'gpt-x', unit: 'per_token', pricing: { '0': { input: 0, output: 0 } }, note: 'zero it out' },
    });
    await expect(run()).rejects.toMatchObject({ statusCode: 400 });
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('is idempotent: an identical resubmit returns the existing row instead of appending a duplicate', async () => {
    mockRowsInForce.mockResolvedValue([
      {
        modelId: 'gpt-x',
        unit: 'per_token',
        pricing: { '0': TIER },
        note: 'provider price page 2026-07',
        effectiveFrom: new Date(),
      },
    ]);
    const { res, run } = call({
      method: 'POST',
      body: { modelId: 'gpt-x', unit: 'per_token', pricing: { '0': TIER }, note: 'provider price page 2026-07' },
    });
    await run();
    expect(mockAppend).not.toHaveBeenCalled();
    expect(res._getJSONData().row).toMatchObject({ note: 'provider price page 2026-07' });
  });

  it('rejects a reprice without a note (the note IS the audit trail)', async () => {
    const { run } = call({
      method: 'POST',
      body: { modelId: 'gpt-x', unit: 'per_token', pricing: { '0': TIER }, note: '  ' },
    });
    await expect(run()).rejects.toThrow(/note/i);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('rejects the reserved adapter-seed note (would masquerade as seed provenance)', async () => {
    const { run } = call({
      method: 'POST',
      body: { modelId: 'gpt-x', unit: 'per_token', pricing: { '0': TIER }, note: 'adapter-seed' },
    });
    await expect(run()).rejects.toThrow(/reserved/i);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('revert-to-seed appends the CURRENT generator rates under the seed note (server-computed, not client-supplied)', async () => {
    mockGenerateSeed.mockResolvedValue([
      { modelId: 'gpt-x', unit: 'per_token', pricing: { '0': { input: 9e-6, output: 27e-6 } } },
    ]);
    const { run } = call({ method: 'POST', body: { modelId: 'gpt-x', unit: 'per_token', action: 'revert-to-seed' } });
    await run();
    const row = mockAppend.mock.calls[0][0];
    expect(row).toMatchObject({
      modelId: 'gpt-x',
      note: 'adapter-seed',
      pricing: { '0': { input: 9e-6, output: 27e-6 } },
    });
  });

  it('rejects revert for a model the seed does not manage', async () => {
    mockGenerateSeed.mockResolvedValue([]);
    const { run } = call({
      method: 'POST',
      body: { modelId: 'ghost-model', unit: 'per_token', action: 'revert-to-seed' },
    });
    await expect(run()).rejects.toThrow(/not seed-managed/);
    expect(mockAppend).not.toHaveBeenCalled();
  });
});
