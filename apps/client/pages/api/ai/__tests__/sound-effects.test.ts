import { isZodError } from '@bike4mind/common';
import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getEffectiveApiKey, subtractCredits, estimateSoundCredits, generate, getSettingsValue, findById, recordUsage } =
  vi.hoisted(() => ({
    getEffectiveApiKey: vi.fn(),
    subtractCredits: vi.fn(),
    estimateSoundCredits: vi.fn(),
    generate: vi.fn(),
    getSettingsValue: vi.fn(),
    findById: vi.fn(),
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
  usageEventRepository: { record: (...a: unknown[]) => recordUsage(...a) },
  userRepository: { findById: (...a: unknown[]) => findById(...a) },
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveApiKey: (...a: unknown[]) => getEffectiveApiKey(...a) },
  creditService: { subtractCredits: (...a: unknown[]) => subtractCredits(...a) },
  estimateSoundCredits: (...a: unknown[]) => estimateSoundCredits(...a),
}));
vi.mock('@bike4mind/utils', () => ({
  aiSoundService: () => ({ generate: (...a: unknown[]) => generate(...a) }),
  getSettingsMap: vi.fn(async () => ({})),
  getSettingsValue: (...a: unknown[]) => getSettingsValue(...a),
}));

import handler from '../sound-effects';

type Handler = (req: unknown, res: unknown) => Promise<void>;

const run = (body: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'u1' }, logger: { error: vi.fn(), warn: vi.fn() } });
  return { res, promise: (handler as Handler)(req, res) };
};

beforeEach(() => {
  [
    getEffectiveApiKey,
    subtractCredits,
    estimateSoundCredits,
    generate,
    getSettingsValue,
    findById,
    recordUsage,
  ].forEach(m => m.mockReset());
  recordUsage.mockResolvedValue(undefined);
  getEffectiveApiKey.mockResolvedValue('eleven-key');
  generate.mockResolvedValue({ audio: Buffer.from('boom'), contentType: 'audio/mpeg' });
});

describe('POST /api/ai/sound-effects', () => {
  it('charges the user after a successful generation when enforceCredits is on', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 12, usdCost: 0.006 });
    findById.mockResolvedValue({ currentCredits: 100 });

    const { res, promise } = run({ text: 'explosion', durationSeconds: 3 });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getData().toString()).toBe('boom');
    expect(subtractCredits).toHaveBeenCalledTimes(1);
    const [params] = subtractCredits.mock.calls[0];
    expect(params).toMatchObject({ type: 'sound_effects_usage', credits: 12, ownerId: 'u1' });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'sound_effects', creditsCharged: 12, costUsd: 0.006, status: 'ok' })
    );
  });

  it('does NOT charge when enforceCredits is off, but still records analytics (COGS, 0 credits)', async () => {
    getSettingsValue.mockReturnValue(false);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 12, usdCost: 0.006 });

    const { res, promise } = run({ text: 'rain', durationSeconds: 3 });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(subtractCredits).not.toHaveBeenCalled();
    // Analytics is decoupled from billing: the event still fires with the true
    // provider COGS and zero credits charged.
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'sound_effects', creditsCharged: 0, costUsd: 0.006, status: 'ok' })
    );
  });

  it('rejects with 422 (insufficient_credits) before generating when the balance is short', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 50, usdCost: 0.025 });
    findById.mockResolvedValue({ currentCredits: 10 });

    const { res, promise } = run({ text: 'thunder' });
    await promise;

    expect(res._getStatusCode()).toBe(422);
    expect(generate).not.toHaveBeenCalled();
    expect(subtractCredits).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('returns 401 when no provider key resolves (no charge)', async () => {
    getEffectiveApiKey.mockResolvedValue(null);

    const { res, promise } = run({ text: 'rain' });
    await promise;

    expect(res._getStatusCode()).toBe(401);
    expect(generate).not.toHaveBeenCalled();
    expect(subtractCredits).not.toHaveBeenCalled();
  });

  it('rejects an invalid body (422) without resolving a key', async () => {
    const { res, promise } = run({ text: '' });
    await promise;

    expect(res._getStatusCode()).toBe(422);
    expect(getEffectiveApiKey).not.toHaveBeenCalled();
  });

  it('maps an upstream provider failure to 502 and does not charge', async () => {
    getSettingsValue.mockReturnValue(true);
    estimateSoundCredits.mockReturnValue({ requiredCredits: 12, usdCost: 0.006 });
    findById.mockResolvedValue({ currentCredits: 100 });
    generate.mockRejectedValue(new Error('ElevenLabs sound generation failed: 429'));

    const { res, promise } = run({ text: 'thunder' });
    await promise;

    expect(res._getStatusCode()).toBe(502);
    expect(subtractCredits).not.toHaveBeenCalled();
    // A failed generation still logs an analytics event, as an error with no cost.
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'sound_effects', status: 'error', creditsCharged: 0, costUsd: 0 })
    );
  });
});
