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

import handler, {
  MANUAL_REPRICE_BAND_ERROR_CODE,
  MANUAL_REPRICE_MAX_FACTOR,
  MANUAL_REPRICE_MAX_PER_TOKEN_USD,
} from '../model-prices';

const TIER = { input: 4e-6, output: 16e-6 };

/** The in-force row the magnitude band compares a submitted reprice against. */
const inForceRow = { modelId: 'gpt-x', unit: 'per_token', pricing: { '0': TIER }, note: 'invoice A' };

/** grok-4.5's real production shape: a single long-context tier. */
const grokInForce = {
  modelId: 'grok-4.5',
  unit: 'per_token',
  pricing: { '200000': { input: 2e-6, output: 6e-6 } },
  note: 'invoice B',
};

/** A tiered ladder like the four in production; dropping a rung reprices the
 * most expensive traffic sold. */
const ladderInForce = {
  modelId: 'gpt-5.6-sol',
  unit: 'per_token',
  pricing: { '272000': { input: 1.25e-6, output: 10e-6 }, '1050000': { input: 2.5e-6, output: 15e-6 } },
  note: 'invoice C',
};

interface GuardrailError {
  statusCode: number;
  message: string;
  additionalInfo?: { code?: string; confirmToken?: string };
}

function call(options: { method: 'GET' | 'POST'; isAdmin?: boolean; query?: object; body?: object }) {
  const { req, res } = createMocks({ method: options.method, query: options.query ?? {}, body: options.body });
  (req as unknown as { user: { isAdmin: boolean; id: string } }).user = {
    isAdmin: options.isAdmin ?? true,
    id: 'admin-1',
  };
  return { req, res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

const post = async (body: object): Promise<GuardrailError> =>
  (await call({ method: 'POST', body })
    .run()
    .catch((e: GuardrailError) => e)) as GuardrailError;

/** Posts a draft expected to trip the guardrails and returns the rejection,
 * whose confirmToken is the waiver an operator would echo back. */
async function expectGuardrail(body: object): Promise<GuardrailError> {
  const err = await post(body);
  expect(err.statusCode).toBe(400);
  expect(err.additionalInfo?.code).toBe(MANUAL_REPRICE_BAND_ERROR_CODE);
  expect(typeof err.additionalInfo?.confirmToken).toBe('string');
  expect(mockAppend).not.toHaveBeenCalled();
  return err;
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

  it('rejects the reserved discovery: note prefix (a newer seed may supersede automation rows)', async () => {
    const { run } = call({
      method: 'POST',
      body: {
        modelId: 'gpt-x',
        unit: 'per_token',
        pricing: { '0': TIER },
        note: 'discovery:openrouter@2026-07-20',
      },
    });
    await expect(run()).rejects.toThrow(/reserved for discovery provenance/i);
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

  it('stamps the requesting admin on reprices and reverts', async () => {
    mockRowsInForce.mockResolvedValue([{ modelId: 'gpt-x', unit: 'per_token' }]);
    mockGenerateSeed.mockResolvedValue([
      { modelId: 'gpt-x', unit: 'per_token', pricing: { '0': { input: 9e-6, output: 27e-6 } } },
    ]);
    await call({
      method: 'POST',
      body: { modelId: 'gpt-x', unit: 'per_token', pricing: { '0': TIER }, note: 'invoice X' },
    }).run();
    expect(mockAppend.mock.calls[0][0].repricedBy).toBe('admin-1');

    await call({ method: 'POST', body: { modelId: 'gpt-x', unit: 'per_token', action: 'revert-to-seed' } }).run();
    expect(mockAppend.mock.calls[1][0].repricedBy).toBe('admin-1');
  });

  it('rejects a reprice beyond the magnitude band, naming the model, field, both values and the factor', async () => {
    expect(MANUAL_REPRICE_MAX_FACTOR).toBe(10);
    mockRowsInForce.mockResolvedValue([inForceRow]);
    // A $/1M figure typed into a per-token field: 1e6 off, in force immediately.
    const err = await expectGuardrail({
      modelId: 'gpt-x',
      unit: 'per_token',
      pricing: { '0': { input: 4, output: 16 } },
      note: 'unit slip',
    });
    expect(err.message).toContain('gpt-x input');
    expect(err.message).toContain('$4 -> $4000000 per 1M tokens');
    expect(err.message).toContain('1000000x move');
    expect(err.message).toContain(`${MANUAL_REPRICE_MAX_FACTOR}x manual reprice band`);
  });

  it('measures the move symmetrically: a 1e6 cut is rejected the same as a 1e6 raise', async () => {
    mockRowsInForce.mockResolvedValue([inForceRow]);
    const err = await expectGuardrail({
      modelId: 'gpt-x',
      unit: 'per_token',
      pricing: { '0': { input: 4e-12, output: 16e-6 } },
      note: 'slip',
    });
    expect(err.message).toContain('1000000x move');
  });

  it('enumerates EVERY violation in one rejection, so a confirm cannot waive one the operator never saw', async () => {
    mockRowsInForce.mockResolvedValue([grokInForce]);
    // A deliberate 30x input raise alongside a fat-fingered output ($6000000/1M).
    const err = await expectGuardrail({
      modelId: 'grok-4.5',
      unit: 'per_token',
      pricing: { '200000': { input: 6e-5, output: 6 } },
      note: 'negotiated input rate',
    });
    expect(err.message).toContain('2 changes need confirmation');
    expect(err.message).toContain('grok-4.5 input (tier 200000): $2 -> $60 per 1M tokens is a 30x move');
    expect(err.message).toContain('grok-4.5 output (tier 200000): $6 -> $6000000 per 1M tokens is a 1000000x move');
  });

  it('applies an over-band reprice when the body echoes the rejection confirmToken', async () => {
    mockRowsInForce.mockResolvedValue([inForceRow]);
    const draft = { modelId: 'gpt-x', unit: 'per_token', pricing: { '0': { input: 4, output: 16 } } };
    const err = await expectGuardrail({ ...draft, note: 'unit slip, reviewed' });

    await call({
      method: 'POST',
      body: { ...draft, note: 'unit slip, reviewed', confirm: err.additionalInfo?.confirmToken },
    }).run();
    expect(mockAppend).toHaveBeenCalledTimes(1);
    expect(mockAppend.mock.calls[0][0]).toMatchObject({ pricing: { '0': { input: 4, output: 16 } } });
  });

  it('refuses a blanket boolean confirm: a waiver has to name the values it waives', async () => {
    mockRowsInForce.mockResolvedValue([inForceRow]);
    const err = await post({
      modelId: 'gpt-x',
      unit: 'per_token',
      pricing: { '0': { input: 4, output: 16 } },
      note: 'unit slip',
      confirm: true,
    });
    expect(err.statusCode).toBe(400);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('withdraws a waiver server-side once any rate changes, then honors the token reissued for the fix', async () => {
    mockRowsInForce.mockResolvedValue([grokInForce]);
    const rejected = await expectGuardrail({
      modelId: 'grok-4.5',
      unit: 'per_token',
      pricing: { '200000': { input: 6e-5, output: 6 } },
      note: 'negotiated input rate',
    });

    // Output typo fixed, waiver from the previous draft reused: the digest no
    // longer matches, so the 30x input move is NOT applied unseen.
    const fixed = { input: 6e-5, output: 6e-5 };
    const stale = await post({
      modelId: 'grok-4.5',
      unit: 'per_token',
      pricing: { '200000': fixed },
      note: 'negotiated input rate',
      confirm: rejected.additionalInfo?.confirmToken,
    });
    expect(stale.message).toContain('does not match this draft');
    expect(stale.additionalInfo?.confirmToken).not.toBe(rejected.additionalInfo?.confirmToken);
    expect(mockAppend).not.toHaveBeenCalled();

    await call({
      method: 'POST',
      body: {
        modelId: 'grok-4.5',
        unit: 'per_token',
        pricing: { '200000': fixed },
        note: 'negotiated input rate',
        confirm: stale.additionalInfo?.confirmToken,
      },
    }).run();
    expect(mockAppend).toHaveBeenCalledTimes(1);
    expect(mockAppend.mock.calls[0][0]).toMatchObject({ pricing: { '200000': fixed } });
  });

  it('compares a rate field the row in force lacks against the seed rather than skipping it', async () => {
    mockRowsInForce.mockResolvedValue([
      {
        modelId: 'claude-3-5-sonnet-20241022',
        unit: 'per_token',
        pricing: { '200000': { input: 3e-6, output: 15e-6 } },
      },
    ]);
    mockGenerateSeed.mockResolvedValue([
      {
        modelId: 'claude-3-5-sonnet-20241022',
        unit: 'per_token',
        pricing: { '200000': { input: 3e-6, output: 15e-6, cache_write: 3.75e-6 } },
      },
    ]);
    const err = await expectGuardrail({
      modelId: 'claude-3-5-sonnet-20241022',
      unit: 'per_token',
      // $3.75/1M typed raw into a per-token field.
      pricing: { '200000': { input: 3e-6, output: 15e-6, cache_write: 3.75 } },
      note: 'cache pricing',
    });
    expect(err.message).toContain('cache_write (tier 200000): $3.75 -> $3750000 per 1M tokens is a 1000000x move');
  });

  it('catches a rate field with no baseline in force AND none in the seed via the absolute ceiling', async () => {
    expect(MANUAL_REPRICE_MAX_PER_TOKEN_USD).toBe(1e-2);
    mockRowsInForce.mockResolvedValue([
      {
        modelId: 'claude-3-5-sonnet-20241022',
        unit: 'per_token',
        pricing: { '200000': { input: 3e-6, output: 15e-6 } },
      },
    ]);
    mockGenerateSeed.mockResolvedValue([
      {
        modelId: 'claude-3-5-sonnet-20241022',
        unit: 'per_token',
        pricing: { '200000': { input: 3e-6, output: 15e-6 } },
      },
    ]);
    const err = await expectGuardrail({
      modelId: 'claude-3-5-sonnet-20241022',
      unit: 'per_token',
      pricing: { '200000': { input: 3e-6, output: 15e-6, cache_write: 3.75 } },
      note: 'cache pricing',
    });
    expect(err.message).toContain('cache_write (tier 200000)');
    expect(err.message).toContain('$3750000 per 1M tokens has no rate in force and none in the seed');
    expect(err.message).toContain('$10000 per 1M tokens absolute ceiling');
  });

  it('catches a 1e6 slip on a model with nothing in force and nothing in the seed to compare against', async () => {
    // Known only because a row exists; that row predates the pricing map, so no
    // baseline exists anywhere and only the ceiling stands between it and $4/token.
    mockRowsInForce.mockResolvedValue([{ modelId: 'legacy-model', unit: 'per_token' }]);
    mockGenerateSeed.mockResolvedValue([]);
    const err = await expectGuardrail({
      modelId: 'legacy-model',
      unit: 'per_token',
      pricing: { '0': { input: 4, output: 16 } },
      note: 'first priced row',
    });
    expect(err.message).toContain('2 changes need confirmation');
    expect(err.message).toContain('$4000000 per 1M tokens has no rate in force and none in the seed');
    expect(err.message).toContain('$16000000 per 1M tokens has no rate in force and none in the seed');
  });

  it('needs confirmation for a brand-new tier inside an existing row, naming the tier and the ceiling breach', async () => {
    mockRowsInForce.mockResolvedValue([ladderInForce]);
    const err = await expectGuardrail({
      modelId: 'gpt-5.6-sol',
      unit: 'per_token',
      pricing: { ...ladderInForce.pricing, '1000': { input: 2, output: 6 } },
      note: 'add a short-prompt tier',
    });
    expect(err.message).toContain('gpt-5.6-sol tier ladder: adding tier 1000');
    expect(err.message).toContain('gpt-5.6-sol input (tier 1000)');
    expect(err.message).toContain('absolute ceiling');
  });

  it('needs confirmation when a tier disappears from a ladder, and applies the drop with the token', async () => {
    mockRowsInForce.mockResolvedValue([ladderInForce]);
    const draft = {
      modelId: 'gpt-5.6-sol',
      unit: 'per_token',
      pricing: { '272000': ladderInForce.pricing['272000'] },
      note: 'consolidate tiers',
    };
    const err = await expectGuardrail(draft);
    expect(err.message).toContain('gpt-5.6-sol tier ladder: dropping tier 1050000');

    await call({ method: 'POST', body: { ...draft, confirm: err.additionalInfo?.confirmToken } }).run();
    expect(mockAppend).toHaveBeenCalledTimes(1);
    expect(Object.keys(mockAppend.mock.calls[0][0].pricing)).toEqual(['272000']);
  });

  it('rejects a leading-zero tier key: one threshold must have exactly one spelling in the map', async () => {
    mockRowsInForce.mockResolvedValue([grokInForce]);
    const err = await post({
      modelId: 'grok-4.5',
      unit: 'per_token',
      pricing: { '0200000': { input: 2e-6, output: 6e-6 } },
      note: 'respelled tier',
    });
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('leading zero');
    expect(err.additionalInfo?.code).toBeUndefined();
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('matches tiers numerically, so a legacy leading-zero key in force still supplies the baseline', async () => {
    mockRowsInForce.mockResolvedValue([
      { modelId: 'grok-4.5', unit: 'per_token', pricing: { '0200000': { input: 2e-6, output: 6e-6 } }, note: 'legacy' },
    ]);
    const err = await expectGuardrail({
      modelId: 'grok-4.5',
      unit: 'per_token',
      pricing: { '200000': { input: 2, output: 6e-6 } },
      note: 'unit slip',
    });
    expect(err.message).toContain('$2 -> $2000000 per 1M tokens is a 1000000x move');
    // The respelled key is the same tier, so the ladder is unchanged.
    expect(err.message).not.toContain('tier ladder');
  });

  it('leaves a within-band reprice alone (a 5x move needs no confirm)', async () => {
    mockRowsInForce.mockResolvedValue([inForceRow]);
    const { run } = call({
      method: 'POST',
      body: {
        modelId: 'gpt-x',
        unit: 'per_token',
        pricing: { '0': { input: 2e-5, output: 8e-5 } },
        note: 'provider raised prices',
      },
    });
    await run();
    expect(mockAppend).toHaveBeenCalledTimes(1);
  });

  it('round-trips a tier ladder through an ordinary within-band edit', async () => {
    mockRowsInForce.mockResolvedValue([ladderInForce]);
    const pricing = {
      '272000': { input: 1.25e-6, output: 12e-6 },
      '1050000': { input: 2.5e-6, output: 18e-6 },
    };
    await call({
      method: 'POST',
      body: { modelId: 'gpt-5.6-sol', unit: 'per_token', pricing, note: 'provider price page' },
    }).run();
    expect(mockAppend).toHaveBeenCalledTimes(1);
    expect(mockAppend.mock.calls[0][0].pricing).toEqual(pricing);
  });

  it('still requires confirmation for a large-but-real move, and applies it with the token', async () => {
    mockRowsInForce.mockResolvedValue([
      { modelId: 'gpt-x', unit: 'per_token', pricing: { '0': { input: 3e-6, output: 16e-6 } }, note: 'invoice A' },
    ]);
    const draft = {
      modelId: 'gpt-x',
      unit: 'per_token',
      // $3/1M -> $60/1M: real, but 20x, so it is shown before it settles calls.
      pricing: { '0': { input: 6e-5, output: 16e-6 } },
      note: 'provider raised the input rate',
    };
    const err = await expectGuardrail(draft);
    expect(err.message).toContain('$3 -> $60 per 1M tokens is a 20x move');
    expect(err.message).not.toContain('absolute ceiling');

    await call({ method: 'POST', body: { ...draft, confirm: err.additionalInfo?.confirmToken } }).run();
    expect(mockAppend).toHaveBeenCalledTimes(1);
    expect(mockAppend.mock.calls[0][0]).toMatchObject({ pricing: { '0': { input: 6e-5, output: 16e-6 } } });
  });

  it('honors the seed baseline when nothing is in force: a first-ever row is not a free pass', async () => {
    mockRowsInForce.mockResolvedValue([]);
    const err = await expectGuardrail({
      modelId: 'gpt-x',
      unit: 'per_token',
      pricing: { '0': { input: 4, output: 16 } },
      note: 'first row',
    });
    expect(err.message).toContain('gpt-x input (tier 0): $4 -> $4000000 per 1M tokens is a 1000000x move');
    expect(err.message).toContain('gpt-x output (tier 0): $16 -> $16000000 per 1M tokens is a 1000000x move');
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
