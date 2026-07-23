import { CreditHolderType, isZodError } from '@bike4mind/common';
import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getEffectiveApiKey,
  deductCredits,
  estimateSoundCredits,
  generate,
  getSettingsValue,
  findById,
  orgFindById,
  userIncrement,
  orgIncrement,
  recordUsage,
} = vi.hoisted(() => ({
  getEffectiveApiKey: vi.fn(),
  deductCredits: vi.fn(),
  estimateSoundCredits: vi.fn(),
  generate: vi.fn(),
  getSettingsValue: vi.fn(),
  findById: vi.fn(),
  orgFindById: vi.fn(),
  userIncrement: vi.fn(),
  orgIncrement: vi.fn(),
  recordUsage: vi.fn(),
}));

// baseApi mock: routes by req.method; a thrown ZodError maps to 422 (mirroring
// the real errorHandler), any other thrown error to its statusCode or 500.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        try {
          return await h[(req as { method?: string }).method ?? 'GET']?.(req, res);
        } catch (err) {
          const status = isZodError(err)
            ? 422
            : typeof (err as { statusCode?: number })?.statusCode === 'number'
              ? (err as { statusCode: number }).statusCode
              : 500;
          (res as { status: (n: number) => { json: (b: unknown) => void } })
            .status(status)
            .json({ error: (err as Error)?.message });
        }
      },
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/utils/errors', () => ({
  BadRequestError: class BadRequestError extends Error {
    statusCode = 400;
  },
}));
vi.mock('@bike4mind/database', () => ({
  apiKeyRepository: {},
  adminSettingsRepository: {},
  creditTransactionRepository: {},
  organizationRepository: {
    findById: (...a: unknown[]) => orgFindById(...a),
    incrementCredits: (...a: unknown[]) => orgIncrement(...a),
  },
  usageEventRepository: { record: (...a: unknown[]) => recordUsage(...a) },
  userRepository: {
    findById: (...a: unknown[]) => findById(...a),
    incrementCredits: (...a: unknown[]) => userIncrement(...a),
  },
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveApiKey: (...a: unknown[]) => getEffectiveApiKey(...a) },
  creditService: { deductCreditsWithOrgSupport: (...a: unknown[]) => deductCredits(...a) },
  estimateSoundCredits: (...a: unknown[]) => estimateSoundCredits(...a),
}));
vi.mock('@bike4mind/utils', () => ({
  aiSoundService: () => ({ generate: (...a: unknown[]) => generate(...a) }),
  getSettingsMap: vi.fn(async () => ({})),
  getSettingsValue: (...a: unknown[]) => getSettingsValue(...a),
}));

import handler from '../sound-effects';

type Handler = (req: unknown, res: unknown) => Promise<void>;

const run = (body: unknown, apiKeyInfo?: unknown, userOrganizationId?: string) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, {
    user: { id: 'u1', organizationId: userOrganizationId ?? null },
    apiKeyInfo,
    logger: { error: vi.fn(), warn: vi.fn() },
  });
  return { res, promise: (handler as Handler)(req, res) };
};

beforeEach(() => {
  [
    getEffectiveApiKey,
    deductCredits,
    estimateSoundCredits,
    generate,
    getSettingsValue,
    findById,
    orgFindById,
    userIncrement,
    orgIncrement,
    recordUsage,
  ].forEach(m => m.mockReset());
  recordUsage.mockResolvedValue(undefined);
  getEffectiveApiKey.mockResolvedValue('eleven-key');
  generate.mockResolvedValue({ audio: Buffer.from('boom'), contentType: 'audio/mpeg' });
  findById.mockResolvedValue({ id: 'u1', currentCredits: 100 });
  // Default reservation results (post-decrement balance, non-negative == funded).
  userIncrement.mockResolvedValue({ currentCredits: 88 });
  orgIncrement.mockResolvedValue({ currentCredits: 980 });
});

describe('POST /api/ai/sound-effects', () => {
  it('reserves then settles the user charge on a successful generation (enforceCredits on)', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 12, usdCost: 0.006, billedSeconds: 3 });

    const { res, promise } = run({ text: 'explosion', durationSeconds: 3 });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getData().toString()).toBe('boom');
    // Reserved up front (single call: funded, no rollback), then settled.
    expect(userIncrement).toHaveBeenCalledTimes(1);
    expect(userIncrement).toHaveBeenCalledWith('u1', -12);
    expect(deductCredits).toHaveBeenCalledTimes(1);
    const [params, , options] = deductCredits.mock.calls[0];
    // No API key -> personal billing: user pool, no organization.
    expect(params).toMatchObject({ type: 'sound_effects_usage', credits: 12, organization: null });
    expect(params.user).toMatchObject({ id: 'u1' });
    // Balance already moved at reservation -> settlement only writes the ledger row.
    expect(options).toMatchObject({ skipBalanceUpdate: true });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'sound_effects',
        ownerId: 'u1',
        ownerType: CreditHolderType.User,
        creditsCharged: 12,
        costUsd: 0.006,
        units: 3,
        status: 'ok',
      })
    );
  });

  it('does NOT reserve or charge when enforceCredits is off, but still records analytics (COGS, 0 credits)', async () => {
    getSettingsValue.mockReturnValue(false);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 12, usdCost: 0.006, billedSeconds: 3 });

    const { res, promise } = run({ text: 'rain', durationSeconds: 3 });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(userIncrement).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    // Analytics is decoupled from billing: the event still fires with the true
    // provider COGS and zero credits charged.
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'sound_effects', creditsCharged: 0, costUsd: 0.006, status: 'ok' })
    );
  });

  it('records billed (not requested) duration as units when duration is omitted', async () => {
    getSettingsValue.mockReturnValue(true);
    // No durationSeconds requested: the estimator bills the vendor auto-duration
    // default, and units must follow the billed value - not the request's undefined.
    estimateSoundCredits.mockReturnValue({ requiredCredits: 73, usdCost: 0.0364, billedSeconds: 200 / 11 });

    const { res, promise } = run({ text: 'ambient hum' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ feature: 'sound_effects', units: 200 / 11 }));
  });

  it('rejects (422) and rolls back the reservation before generating when the balance is short', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 50, usdCost: 0.025, billedSeconds: 12 });
    // Reserve overdraws (had 10, cost 50 -> -40): route must roll back and reject.
    userIncrement.mockResolvedValue({ currentCredits: -40 });

    const { res, promise } = run({ text: 'thunder' });
    await promise;

    expect(res._getStatusCode()).toBe(422);
    // Reserve (-50) then immediate rollback (+50); nothing generated or settled.
    expect(userIncrement).toHaveBeenCalledTimes(2);
    expect(userIncrement).toHaveBeenNthCalledWith(1, 'u1', -50);
    expect(userIncrement).toHaveBeenNthCalledWith(2, 'u1', 50);
    expect(generate).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('returns 401 when no provider key resolves (no reservation)', async () => {
    getEffectiveApiKey.mockResolvedValue(null);

    const { res, promise } = run({ text: 'rain' });
    await promise;

    expect(res._getStatusCode()).toBe(401);
    expect(userIncrement).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('rejects an invalid body (422) without resolving a key', async () => {
    const { res, promise } = run({ text: '' });
    await promise;

    expect(res._getStatusCode()).toBe(422);
    expect(getEffectiveApiKey).not.toHaveBeenCalled();
  });

  it('maps an upstream provider failure to 502 and refunds the reservation', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 12, usdCost: 0.006, billedSeconds: 3 });
    generate.mockRejectedValue(new Error('ElevenLabs sound generation failed: 429'));

    const { res, promise } = run({ text: 'thunder' });
    await promise;

    expect(res._getStatusCode()).toBe(502);
    // Reserved (-12), then refunded (+12) because generation failed; never settled.
    expect(userIncrement).toHaveBeenCalledTimes(2);
    expect(userIncrement).toHaveBeenNthCalledWith(1, 'u1', -12);
    expect(userIncrement).toHaveBeenNthCalledWith(2, 'u1', 12);
    expect(deductCredits).not.toHaveBeenCalled();
    // A failed generation still logs an analytics event, as an error with no cost.
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'sound_effects', status: 'error', creditsCharged: 0, costUsd: 0 })
    );
  });

  it('still reports the charge (creditsCharged) when the settlement ledger write fails', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 12, usdCost: 0.006, billedSeconds: 3 });
    // Balance already moved at reservation; a settlement failure must NOT free the audio.
    deductCredits.mockRejectedValue(new Error('mongo down'));

    const { res, promise } = run({ text: 'explosion', durationSeconds: 3 });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getData().toString()).toBe('boom');
    // No refund: the customer was charged at reservation; only the ledger row is missing.
    expect(userIncrement).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'sound_effects', status: 'ok', creditsCharged: 12 })
    );
  });

  const orgKey = { billingOwnerType: CreditHolderType.Organization, organizationId: 'org1' };

  it('reserves and settles against the org pool for an org-billed API key (user stays the actor)', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 20, usdCost: 0.01, billedSeconds: 5 });
    // Personal pool is empty on purpose: an org-billed key must draw from the org.
    findById.mockResolvedValue({ id: 'u1', currentCredits: 0 });
    orgFindById.mockResolvedValue({ id: 'org1', currentCredits: 1000, userDetails: [] });

    const { res, promise } = run({ text: 'explosion', durationSeconds: 5 }, orgKey);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    // Reserved against the org, not the user.
    expect(orgIncrement).toHaveBeenCalledWith('org1', -20);
    expect(userIncrement).not.toHaveBeenCalled();
    expect(deductCredits).toHaveBeenCalledTimes(1);
    const [params] = deductCredits.mock.calls[0];
    expect(params).toMatchObject({ type: 'sound_effects_usage', credits: 20 });
    expect(params.organization).toMatchObject({ id: 'org1' });
    expect(params.user).toMatchObject({ id: 'u1' });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'org1',
        ownerType: CreditHolderType.Organization,
        userId: 'u1',
        creditsCharged: 20,
      })
    );
  });

  it('bills the org seat of a browser/JWT member (organizationId from the user)', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 15, usdCost: 0.0075, billedSeconds: 4 });
    orgFindById.mockResolvedValue({ id: 'orgSeat', currentCredits: 500, userDetails: [] });

    // No API key: JWT session whose user belongs to an org.
    const { res, promise } = run({ text: 'chime' }, undefined, 'orgSeat');
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(orgFindById).toHaveBeenCalledWith('orgSeat');
    expect(orgIncrement).toHaveBeenCalledWith('orgSeat', -15);
    expect(userIncrement).not.toHaveBeenCalled();
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'orgSeat', ownerType: CreditHolderType.Organization, userId: 'u1' })
    );
  });

  it('rejects (422) and rolls back before generating when the org pool is short (personal balance ignored)', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 50, usdCost: 0.025, billedSeconds: 12 });
    findById.mockResolvedValue({ id: 'u1', currentCredits: 100000 });
    orgFindById.mockResolvedValue({ id: 'org1', currentCredits: 10, userDetails: [] });
    orgIncrement.mockResolvedValue({ currentCredits: -40 });

    const { res, promise } = run({ text: 'thunder' }, orgKey);
    await promise;

    expect(res._getStatusCode()).toBe(422);
    expect(orgIncrement).toHaveBeenNthCalledWith(1, 'org1', -50);
    expect(orgIncrement).toHaveBeenNthCalledWith(2, 'org1', 50);
    expect(generate).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('rejects (422) before reserving when the org per-member cap is reached', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 30, usdCost: 0.015, billedSeconds: 8 });
    // Pool is flush, but the member's usage + this request exceeds maxCreditsPerMember (20 + 30 > 40).
    orgFindById.mockResolvedValue({
      id: 'org1',
      currentCredits: 10000,
      maxCreditsPerMember: 40,
      userDetails: [{ id: 'u1', usedCredits: 20 }],
    });

    const { res, promise } = run({ text: 'boom' }, orgKey);
    await promise;

    expect(res._getStatusCode()).toBe(422);
    // Cap is enforced before touching the pool.
    expect(orgIncrement).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('bills the user pool for a user-billed API key (billingOwnerType User), ignoring the org seat', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 12, usdCost: 0.006, billedSeconds: 3 });

    // User-billed key even though the user has an org seat: bill the user.
    const { res, promise } = run({ text: 'rain' }, { billingOwnerType: CreditHolderType.User }, 'orgSeat');
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(orgFindById).not.toHaveBeenCalled();
    expect(orgIncrement).not.toHaveBeenCalled();
    expect(userIncrement).toHaveBeenCalledWith('u1', -12);
    const [params] = deductCredits.mock.calls[0];
    expect(params.organization).toBeNull();
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'u1', ownerType: CreditHolderType.User })
    );
  });
});
