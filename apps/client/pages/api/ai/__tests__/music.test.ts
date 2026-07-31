import { CreditHolderType, isZodError } from '@bike4mind/common';
import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getEffectiveApiKey,
  deductCredits,
  estimateMusicCredits,
  generate,
  getSettingsValue,
  findById,
  orgFindById,
  userIncrement,
  orgIncrement,
  recordUsage,
  persistGeneratedAudio,
} = vi.hoisted(() => ({
  getEffectiveApiKey: vi.fn(),
  deductCredits: vi.fn(),
  estimateMusicCredits: vi.fn(),
  generate: vi.fn(),
  getSettingsValue: vi.fn(),
  findById: vi.fn(),
  orgFindById: vi.fn(),
  userIncrement: vi.fn(),
  orgIncrement: vi.fn(),
  recordUsage: vi.fn(),
  persistGeneratedAudio: vi.fn(),
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
  estimateMusicCredits: (...a: unknown[]) => estimateMusicCredits(...a),
}));
vi.mock('@bike4mind/utils', () => ({
  aiMusicService: () => ({ generate: (...a: unknown[]) => generate(...a) }),
  getSettingsMap: vi.fn(async () => ({})),
  getSettingsValue: (...a: unknown[]) => getSettingsValue(...a),
}));
vi.mock('@server/utils/persistGeneratedAudio', () => ({
  persistGeneratedAudio: (...a: unknown[]) => persistGeneratedAudio(...a),
}));

import handler from '../music';

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
    estimateMusicCredits,
    generate,
    getSettingsValue,
    findById,
    orgFindById,
    userIncrement,
    orgIncrement,
    recordUsage,
    persistGeneratedAudio,
  ].forEach(m => m.mockReset());
  recordUsage.mockResolvedValue(undefined);
  // Default: persistence is a no-op that reports "not saved", so tests not
  // exercising the save path see no persisted-file headers.
  persistGeneratedAudio.mockResolvedValue({ saved: false, reason: 'error' });
  getEffectiveApiKey.mockResolvedValue('eleven-key');
  generate.mockResolvedValue({ audio: Buffer.from('song'), contentType: 'audio/mpeg' });
  findById.mockResolvedValue({ id: 'u1', currentCredits: 1000 });
  // Default reservation results (post-decrement balance, non-negative == funded).
  userIncrement.mockResolvedValue({ currentCredits: 850 });
  orgIncrement.mockResolvedValue({ currentCredits: 9000 });
});

describe('POST /api/ai/music', () => {
  it('reserves then settles the user charge on a successful generation (enforceCredits on)', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateMusicCredits.mockReturnValue({ requiredCredits: 150, usdCost: 0.075, billedSeconds: 30 });

    const { res, promise } = run({ prompt: 'lofi beat', lengthMs: 30000 });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getData().toString()).toBe('song');
    // The billed length is what's forced on the provider: the same lengthMs must
    // drive the cost estimate AND the generate call, or billed != generated.
    expect(estimateMusicCredits).toHaveBeenCalledWith('elevenlabs', { lengthMs: 30000 });
    expect(generate).toHaveBeenCalledWith('lofi beat', {
      lengthMs: 30000,
      forceInstrumental: undefined,
      modelId: 'music_v1',
      format: undefined,
    });
    // Reserved up front (single call: funded, no rollback), then settled.
    expect(userIncrement).toHaveBeenCalledTimes(1);
    expect(userIncrement).toHaveBeenCalledWith('u1', -150);
    expect(deductCredits).toHaveBeenCalledTimes(1);
    const [params, , options] = deductCredits.mock.calls[0];
    // No API key -> personal billing: user pool, no organization.
    expect(params).toMatchObject({
      type: 'music_generation_usage',
      credits: 150,
      organization: null,
      model: 'music_v1',
    });
    expect(params.user).toMatchObject({ id: 'u1' });
    // Balance already moved at reservation -> settlement only writes the ledger row.
    expect(options).toMatchObject({ skipBalanceUpdate: true });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'music_generation',
        provider: 'elevenlabs',
        model: 'music_v1',
        ownerId: 'u1',
        ownerType: CreditHolderType.User,
        creditsCharged: 150,
        costUsd: 0.075,
        units: 30,
        status: 'ok',
      })
    );
  });

  it('does NOT reserve or charge when enforceCredits is off, but still records analytics (COGS, 0 credits)', async () => {
    getSettingsValue.mockReturnValue(false);
    estimateMusicCredits.mockReturnValue({ requiredCredits: 150, usdCost: 0.075, billedSeconds: 30 });

    const { res, promise } = run({ prompt: 'ambient pad', lengthMs: 30000 });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(userIncrement).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    // Analytics is decoupled from billing: the event still fires with the true
    // provider COGS and zero credits charged.
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'music_generation', creditsCharged: 0, costUsd: 0.075, status: 'ok' })
    );
  });

  it('records the billed length as units', async () => {
    getSettingsValue.mockReturnValue(true);
    // Length defaulted by the schema when omitted; the estimator bills that
    // length and units must follow the billed value.
    estimateMusicCredits.mockReturnValue({ requiredCredits: 50, usdCost: 0.025, billedSeconds: 10 });

    const { res, promise } = run({ prompt: 'background music' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ feature: 'music_generation', units: 10 }));
  });

  it('rejects (422) and rolls back the reservation before generating when the balance is short', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateMusicCredits.mockReturnValue({ requiredCredits: 300, usdCost: 0.15, billedSeconds: 60 });
    // Reserve overdraws: route must roll back and reject.
    userIncrement.mockResolvedValue({ currentCredits: -40 });

    const { res, promise } = run({ prompt: 'epic orchestral', lengthMs: 60000 });
    await promise;

    expect(res._getStatusCode()).toBe(422);
    // Reserve (-300) then immediate rollback (+300); nothing generated or settled.
    expect(userIncrement).toHaveBeenCalledTimes(2);
    expect(userIncrement).toHaveBeenNthCalledWith(1, 'u1', -300);
    expect(userIncrement).toHaveBeenNthCalledWith(2, 'u1', 300);
    expect(generate).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('returns 503 (not 401) when no provider key resolves (no reservation)', async () => {
    getEffectiveApiKey.mockResolvedValue(null);

    const { res, promise } = run({ prompt: 'jazz', lengthMs: 30000 });
    await promise;

    // A missing provider key is a capability gap, not an auth failure - a 401 would
    // wrongly tell an API-key caller to re-authenticate.
    expect(res._getStatusCode()).toBe(503);
    expect(res._getJSONData()).toMatchObject({ error: 'No elevenlabs API key configured' });
    expect(userIncrement).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('forwards the persisted-file id, name, and signed URL as response headers', async () => {
    getSettingsValue.mockReturnValue(false);
    estimateMusicCredits.mockReturnValue({ requiredCredits: 0, usdCost: 0, billedSeconds: 30 });
    persistGeneratedAudio.mockResolvedValue({
      saved: true,
      fabFileId: 'fab1',
      fileName: 'music-lofi-beat.mp3',
      fileUrl: 'https://signed.example/music.mp3',
    });

    const { res, promise } = run({ prompt: 'lofi beat', lengthMs: 30000 });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    // Persisted under the 'music' source so it's tagged/named as music, not a
    // sound effect (the two routes share persistGeneratedAudio).
    expect(persistGeneratedAudio).toHaveBeenCalledWith(expect.objectContaining({ source: 'music' }));
    // The signed URL must ride the header: the CLI cannot re-resolve one via
    // GET /api/files/:id until the async moderation scan flips the file to 'clean'.
    expect(res.getHeader('X-B4M-Audio-Saved')).toBe('true');
    expect(res.getHeader('X-B4M-Audio-Fab-File-Id')).toBe('fab1');
    expect(res.getHeader('X-B4M-Audio-File-Name')).toBe('music-lofi-beat.mp3');
    expect(res.getHeader('X-B4M-Audio-File-Url')).toBe('https://signed.example/music.mp3');
  });

  it('rejects an invalid body (422) without resolving a key', async () => {
    const { res, promise } = run({ prompt: '' });
    await promise;

    expect(res._getStatusCode()).toBe(422);
    expect(getEffectiveApiKey).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range length (422) without resolving a key', async () => {
    // Below the 3s ElevenLabs minimum.
    const { res, promise } = run({ prompt: 'blip', lengthMs: 500 });
    await promise;

    expect(res._getStatusCode()).toBe(422);
    expect(getEffectiveApiKey).not.toHaveBeenCalled();
  });

  it('maps an upstream provider failure to 502 and refunds the reservation', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateMusicCredits.mockReturnValue({ requiredCredits: 150, usdCost: 0.075, billedSeconds: 30 });
    generate.mockRejectedValue(new Error('ElevenLabs music generation failed: 429'));

    const { res, promise } = run({ prompt: 'thunder score', lengthMs: 30000 });
    await promise;

    expect(res._getStatusCode()).toBe(502);
    // Reserved (-150), then refunded (+150) because generation failed; never settled.
    expect(userIncrement).toHaveBeenCalledTimes(2);
    expect(userIncrement).toHaveBeenNthCalledWith(1, 'u1', -150);
    expect(userIncrement).toHaveBeenNthCalledWith(2, 'u1', 150);
    expect(deductCredits).not.toHaveBeenCalled();
    // A failed generation still logs an analytics event, as an error with no cost.
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'music_generation', status: 'error', creditsCharged: 0, costUsd: 0 })
    );
  });

  it('refunds the ORG pool (not the user) when an org-billed generation fails', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateMusicCredits.mockReturnValue({ requiredCredits: 200, usdCost: 0.1, billedSeconds: 40 });
    findById.mockResolvedValue({ id: 'u1', currentCredits: 0 });
    orgFindById.mockResolvedValue({ id: 'org1', currentCredits: 10000, userDetails: [] });
    generate.mockRejectedValue(new Error('ElevenLabs music generation failed: 500'));

    const { res, promise } = run(
      { prompt: 'orchestral', lengthMs: 40000 },
      { billingOwnerType: CreditHolderType.Organization, organizationId: 'org1' }
    );
    await promise;

    expect(res._getStatusCode()).toBe(502);
    // The refund must go back to whoever was reserved against - the org, via
    // holderMethods - not the user pool.
    expect(orgIncrement).toHaveBeenNthCalledWith(1, 'org1', -200);
    expect(orgIncrement).toHaveBeenNthCalledWith(2, 'org1', 200);
    expect(userIncrement).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('still reports the charge (creditsCharged) when the settlement ledger write fails', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateMusicCredits.mockReturnValue({ requiredCredits: 150, usdCost: 0.075, billedSeconds: 30 });
    // Balance already moved at reservation; a settlement failure must NOT free the audio.
    deductCredits.mockRejectedValue(new Error('mongo down'));

    const { res, promise } = run({ prompt: 'lofi beat', lengthMs: 30000 });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getData().toString()).toBe('song');
    // No refund: the customer was charged at reservation; only the ledger row is missing.
    expect(userIncrement).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'music_generation', status: 'ok', creditsCharged: 150 })
    );
  });

  const orgKey = { billingOwnerType: CreditHolderType.Organization, organizationId: 'org1' };

  it('reserves and settles against the org pool for an org-billed API key (user stays the actor)', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateMusicCredits.mockReturnValue({ requiredCredits: 200, usdCost: 0.1, billedSeconds: 40 });
    // Personal pool is empty on purpose: an org-billed key must draw from the org.
    findById.mockResolvedValue({ id: 'u1', currentCredits: 0 });
    orgFindById.mockResolvedValue({ id: 'org1', currentCredits: 10000, userDetails: [] });

    const { res, promise } = run({ prompt: 'orchestral', lengthMs: 40000 }, orgKey);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    // Reserved against the org, not the user.
    expect(orgIncrement).toHaveBeenCalledWith('org1', -200);
    expect(userIncrement).not.toHaveBeenCalled();
    expect(deductCredits).toHaveBeenCalledTimes(1);
    const [params] = deductCredits.mock.calls[0];
    expect(params).toMatchObject({ type: 'music_generation_usage', credits: 200 });
    expect(params.organization).toMatchObject({ id: 'org1' });
    expect(params.user).toMatchObject({ id: 'u1' });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'org1',
        ownerType: CreditHolderType.Organization,
        userId: 'u1',
        creditsCharged: 200,
      })
    );
  });

  it('bills the org seat of a browser/JWT member (organizationId from the user)', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateMusicCredits.mockReturnValue({ requiredCredits: 100, usdCost: 0.05, billedSeconds: 20 });
    orgFindById.mockResolvedValue({ id: 'orgSeat', currentCredits: 5000, userDetails: [] });

    // No API key: JWT session whose user belongs to an org.
    const { res, promise } = run({ prompt: 'chime melody', lengthMs: 20000 }, undefined, 'orgSeat');
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(orgFindById).toHaveBeenCalledWith('orgSeat');
    expect(orgIncrement).toHaveBeenCalledWith('orgSeat', -100);
    expect(userIncrement).not.toHaveBeenCalled();
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'orgSeat', ownerType: CreditHolderType.Organization, userId: 'u1' })
    );
  });

  it('rejects (422) before reserving when the org per-member cap is reached', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateMusicCredits.mockReturnValue({ requiredCredits: 300, usdCost: 0.15, billedSeconds: 60 });
    // Pool is flush, but the member's usage + this request exceeds maxCreditsPerMember (100 + 300 > 200).
    orgFindById.mockResolvedValue({
      id: 'org1',
      currentCredits: 100000,
      maxCreditsPerMember: 200,
      userDetails: [{ id: 'u1', usedCredits: 100 }],
    });

    const { res, promise } = run({ prompt: 'anthem', lengthMs: 60000 }, orgKey);
    await promise;

    expect(res._getStatusCode()).toBe(422);
    // Cap is enforced before touching the pool.
    expect(orgIncrement).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('bills the user pool for a user-billed API key (billingOwnerType User), ignoring the org seat', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateMusicCredits.mockReturnValue({ requiredCredits: 150, usdCost: 0.075, billedSeconds: 30 });

    // User-billed key even though the user has an org seat: bill the user.
    const { res, promise } = run(
      { prompt: 'rainy jazz', lengthMs: 30000 },
      { billingOwnerType: CreditHolderType.User },
      'orgSeat'
    );
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(orgFindById).not.toHaveBeenCalled();
    expect(orgIncrement).not.toHaveBeenCalled();
    expect(userIncrement).toHaveBeenCalledWith('u1', -150);
    const [params] = deductCredits.mock.calls[0];
    expect(params.organization).toBeNull();
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'u1', ownerType: CreditHolderType.User })
    );
  });
});
