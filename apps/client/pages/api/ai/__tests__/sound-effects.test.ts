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
  recordUsage,
} = vi.hoisted(() => ({
  getEffectiveApiKey: vi.fn(),
  deductCredits: vi.fn(),
  estimateSoundCredits: vi.fn(),
  generate: vi.fn(),
  getSettingsValue: vi.fn(),
  findById: vi.fn(),
  orgFindById: vi.fn(),
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
  organizationRepository: { findById: (...a: unknown[]) => orgFindById(...a) },
  usageEventRepository: { record: (...a: unknown[]) => recordUsage(...a) },
  userRepository: { findById: (...a: unknown[]) => findById(...a) },
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

const run = (body: unknown, apiKeyInfo?: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'u1' }, apiKeyInfo, logger: { error: vi.fn(), warn: vi.fn() } });
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
    recordUsage,
  ].forEach(m => m.mockReset());
  recordUsage.mockResolvedValue(undefined);
  getEffectiveApiKey.mockResolvedValue('eleven-key');
  generate.mockResolvedValue({ audio: Buffer.from('boom'), contentType: 'audio/mpeg' });
  findById.mockResolvedValue({ id: 'u1', currentCredits: 100 });
});

describe('POST /api/ai/sound-effects', () => {
  it('charges the user after a successful generation when enforceCredits is on', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 12, usdCost: 0.006, billedSeconds: 3 });
    findById.mockResolvedValue({ id: 'u1', currentCredits: 100 });

    const { res, promise } = run({ text: 'explosion', durationSeconds: 3 });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getData().toString()).toBe('boom');
    expect(deductCredits).toHaveBeenCalledTimes(1);
    const [params] = deductCredits.mock.calls[0];
    // No API key -> personal billing: user pool, no organization.
    expect(params).toMatchObject({ type: 'sound_effects_usage', credits: 12, organization: null });
    expect(params.user).toMatchObject({ id: 'u1' });
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

  it('does NOT charge when enforceCredits is off, but still records analytics (COGS, 0 credits)', async () => {
    getSettingsValue.mockReturnValue(false);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 12, usdCost: 0.006, billedSeconds: 3 });

    const { res, promise } = run({ text: 'rain', durationSeconds: 3 });
    await promise;

    expect(res._getStatusCode()).toBe(200);
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
    findById.mockResolvedValue({ currentCredits: 1000 });

    const { res, promise } = run({ text: 'ambient hum' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ feature: 'sound_effects', units: 200 / 11 }));
  });

  it('rejects with 422 (insufficient_credits) before generating when the balance is short', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 50, usdCost: 0.025, billedSeconds: 12 });
    findById.mockResolvedValue({ currentCredits: 10 });

    const { res, promise } = run({ text: 'thunder' });
    await promise;

    expect(res._getStatusCode()).toBe(422);
    expect(generate).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('returns 401 when no provider key resolves (no charge)', async () => {
    getEffectiveApiKey.mockResolvedValue(null);

    const { res, promise } = run({ text: 'rain' });
    await promise;

    expect(res._getStatusCode()).toBe(401);
    expect(generate).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('rejects an invalid body (422) without resolving a key', async () => {
    const { res, promise } = run({ text: '' });
    await promise;

    expect(res._getStatusCode()).toBe(422);
    expect(getEffectiveApiKey).not.toHaveBeenCalled();
  });

  it('maps an upstream provider failure to 502 and does not charge', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 12, usdCost: 0.006, billedSeconds: 3 });
    findById.mockResolvedValue({ currentCredits: 100 });
    generate.mockRejectedValue(new Error('ElevenLabs sound generation failed: 429'));

    const { res, promise } = run({ text: 'thunder' });
    await promise;

    expect(res._getStatusCode()).toBe(502);
    expect(deductCredits).not.toHaveBeenCalled();
    // A failed generation still logs an analytics event, as an error with no cost.
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'sound_effects', status: 'error', creditsCharged: 0, costUsd: 0 })
    );
  });

  const orgKey = { billingOwnerType: CreditHolderType.Organization, organizationId: 'org1' };

  it('charges the organization pool for an org-billed API key (user stays the actor)', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 20, usdCost: 0.01, billedSeconds: 5 });
    // Personal pool is empty on purpose: an org-billed key must draw from the org.
    findById.mockResolvedValue({ id: 'u1', currentCredits: 0 });
    orgFindById.mockResolvedValue({ id: 'org1', currentCredits: 1000, userDetails: [] });

    const { res, promise } = run({ text: 'explosion', durationSeconds: 5 }, orgKey);
    await promise;

    expect(res._getStatusCode()).toBe(200);
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

  it('rejects (422) before generating when the org pool is short (personal balance ignored)', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 50, usdCost: 0.025, billedSeconds: 12 });
    findById.mockResolvedValue({ id: 'u1', currentCredits: 100000 });
    orgFindById.mockResolvedValue({ id: 'org1', currentCredits: 10, userDetails: [] });

    const { res, promise } = run({ text: 'thunder' }, orgKey);
    await promise;

    expect(res._getStatusCode()).toBe(422);
    expect(generate).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('rejects (422) before generating when the org per-member cap is reached', async () => {
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
    expect(generate).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('bills the user pool for a user-billed API key (billingOwnerType User)', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 12, usdCost: 0.006, billedSeconds: 3 });
    findById.mockResolvedValue({ id: 'u1', currentCredits: 100 });

    const { res, promise } = run({ text: 'rain' }, { billingOwnerType: CreditHolderType.User });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(orgFindById).not.toHaveBeenCalled();
    const [params] = deductCredits.mock.calls[0];
    expect(params.organization).toBeNull();
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'u1', ownerType: CreditHolderType.User })
    );
  });
});
