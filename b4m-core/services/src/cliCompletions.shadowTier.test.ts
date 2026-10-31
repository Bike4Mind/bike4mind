import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiKeyService', () => ({ getEffectiveLLMApiKeys: vi.fn().mockResolvedValue({}) }));
vi.mock('./creditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./creditService')>()),
  subtractCredits: vi.fn().mockResolvedValue(undefined),
  isMemberCreditCapExceeded: vi.fn(() => false),
}));

const h = vi.hoisted(() => {
  const pricing = { 200_000: { input: 1e-6, output: 2e-6 } };
  return {
    premium: { id: 'premium-model', type: 'text', backend: 'anthropic', max_tokens: 1000, pricing },
    cheap: { id: 'cheap-model', type: 'text', backend: 'gemini', max_tokens: 1000, pricing },
    complete: vi.fn(),
    getLlmByModel: vi.fn(),
  };
});

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn().mockResolvedValue([h.premium, h.cheap]),
  getLlmByModel: h.getLlmByModel,
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  usdToCredits: vi.fn(() => 10),
  usdToCreditsStochastic: vi.fn(() => 10),
  getSettingsMap: vi.fn().mockResolvedValue({}),
  getSettingsValue: vi.fn((key: string) => {
    if (key === 'shadowTierModelAllowlist') return ['cheap-model'];
    if (key === 'shadowTierDailyTokenCap') return 20000;
    if (key === 'shadowTierRequestsPerMin') return 3;
    if (key === 'freeTierModelGateEnabled') return false;
    return true;
  }),
  getSettingsByNames: vi.fn(),
}));

import { executeCompletion } from './cliCompletions';
import { subtractCredits } from './creditService';

const restricted = { id: 'user1', currentCredits: 100_000, tags: [], throttle: { tier: 'shadow' } };

function buildDb(
  user: Record<string, unknown>,
  { cacheSuccess = true, rpmSuccess = true, balanceAfter = 100_000 } = {}
) {
  // any: minimal repo mocks carrying only the methods executeCompletion calls
  return {
    adminSettings: { findOne: vi.fn().mockResolvedValue(null) } as any,
    apiKeys: {} as any,
    creditTransactions: {} as any,
    users: {
      incrementCredits: vi.fn().mockResolvedValue({ id: 'user1', currentCredits: balanceAfter }),
      findById: vi.fn().mockResolvedValue(user),
    } as any,
    usageEvents: { record: vi.fn().mockResolvedValue(undefined) } as any,
    organizations: {} as any,
    cache: {
      tryIncrementWithinLimitFixedWindow: vi
        .fn()
        .mockResolvedValue({ success: rpmSuccess, count: 4, expiresAt: new Date(Date.now() + 41_500) }),
      tryAddWithinLimitFixedWindow: vi
        .fn()
        .mockResolvedValue({ success: cacheSuccess, count: 1, expiresAt: new Date() }),
    },
  };
}

const run = (db: ReturnType<typeof buildDb>, onChunk = vi.fn().mockResolvedValue(undefined)) =>
  executeCompletion({
    userId: 'user1',
    model: 'premium-model',
    messages: [{ role: 'user', content: 'hi' }],
    onChunk,
    db,
  });

const errorShape = (err: unknown) => {
  const e = err as { name: string; code?: string; message: string };
  return { name: e.name, code: e.code, message: e.message.replace(/\d+/g, 'N') };
};

describe('executeCompletion for a restricted-tier caller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.complete.mockImplementation(async (_m, _msgs, _o, cb) => cb(['ok'], { inputTokens: 30, outputTokens: 5 }));
    h.getLlmByModel.mockImplementation(() => ({ currentModel: '', complete: h.complete }));
  });

  it('runs the allowlisted model and reports only the requested one', async () => {
    const db = buildDb(restricted);
    const onChunk = vi.fn().mockResolvedValue(undefined);

    await run(db, onChunk);

    expect(h.getLlmByModel.mock.calls.map(call => call[1].modelInfo.id)).toEqual(['cheap-model']);
    expect(h.getLlmByModel.mock.results[0].value.currentModel).toBe('cheap-model');
    expect(h.complete.mock.calls.map(call => call[0])).toEqual(['cheap-model']);
    expect(db.usageEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'premium-model',
        provider: 'anthropic',
        executedModel: 'cheap-model',
        executedProvider: 'gemini',
      })
    );
    expect(vi.mocked(subtractCredits)).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'premium-model' }),
      expect.anything()
    );
    expect(JSON.stringify(onChunk.mock.calls)).not.toContain('cheap');
    expect(db.cache.tryAddWithinLimitFixedWindow).toHaveBeenCalledWith(
      expect.stringMatching(/^shadow-tokens:user1:/),
      35,
      Number.MAX_SAFE_INTEGER,
      expect.any(Number)
    );
  });

  it('leaves other callers untouched and reads no counter', async () => {
    const db = buildDb({ id: 'user1', currentCredits: 100_000, tags: [] });

    await run(db);

    expect(h.complete.mock.calls.map(call => call[0])).toEqual(['premium-model']);
    expect(db.usageEvents.record.mock.calls[0][0]).not.toHaveProperty('executedModel');
    expect(db.cache.tryAddWithinLimitFixedWindow).not.toHaveBeenCalled();
    expect(db.cache.tryIncrementWithinLimitFixedWindow).not.toHaveBeenCalled();
  });

  it('names the requested model for the identity reminder', async () => {
    await run(buildDb(restricted));
    await run(buildDb({ id: 'user1', currentCredits: 100_000, tags: [] }));

    expect(h.complete.mock.calls[0][2]).toMatchObject({ modelIdentityId: 'premium-model' });
    expect(h.complete.mock.calls[1][2]).not.toHaveProperty('modelIdentityId');
  });

  it('over the per-minute limit fails like the standard rate limiter', async () => {
    const db = buildDb(restricted, { rpmSuccess: false });

    const err = await run(db).catch(e => e);

    expect(db.cache.tryIncrementWithinLimitFixedWindow).toHaveBeenCalledWith(
      'rate-limit:user1:external-completions',
      3,
      60_000
    );
    expect(err).toMatchObject({ name: 'TooManyRequestsError', statusCode: 429 });
    expect(err.message).toBe('Rate limit exceeded. Try again in 42 seconds.');
    expect(err.additionalInfo).toEqual({ retryAfter: 42 });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('over the daily token cap fails with the out-of-credits error', async () => {
    const outOfCredits = await run(buildDb({ id: 'user1', currentCredits: 0, tags: [] }, { balanceAfter: -10 })).catch(
      err => err
    );
    const overCap = await run(buildDb(restricted, { cacheSuccess: false })).catch(err => err);

    expect(outOfCredits.code).toBe('insufficient_credits');
    expect(errorShape(overCap)).toEqual(errorShape(outOfCredits));
    expect(h.complete).not.toHaveBeenCalled();
  });
});
