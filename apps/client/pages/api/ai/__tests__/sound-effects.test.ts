import { isZodError } from '@bike4mind/common';
import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getApiKey, generate } = vi.hoisted(() => ({
  getApiKey: vi.fn(),
  generate: vi.fn(),
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

vi.mock('@bike4mind/database', () => ({ apiKeyRepository: {} }));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getApiKey: (...a: unknown[]) => getApiKey(...a) },
}));
vi.mock('@bike4mind/utils', () => ({
  aiSoundService: () => ({ generate: (...a: unknown[]) => generate(...a) }),
}));

import handler from '../sound-effects';

type Handler = (req: unknown, res: unknown) => Promise<void>;

const run = (body: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'u1' }, logger: { error: vi.fn() } });
  return { res, promise: (handler as Handler)(req, res) };
};

beforeEach(() => {
  getApiKey.mockReset();
  generate.mockReset();
});

describe('POST /api/ai/sound-effects', () => {
  it('returns generated audio bytes with the vendor content type (200)', async () => {
    getApiKey.mockResolvedValue({ apiKey: 'eleven-key' });
    generate.mockResolvedValue({ audio: Buffer.from('boom'), contentType: 'audio/mpeg' });

    const { res, promise } = run({ text: 'explosion', durationSeconds: 2 });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('audio/mpeg');
    expect(res._getData().toString()).toBe('boom');
    expect(generate).toHaveBeenCalledWith('explosion', {
      durationSeconds: 2,
      promptInfluence: undefined,
      format: undefined,
    });
  });

  it('returns 401 when the provider key is not configured', async () => {
    getApiKey.mockResolvedValue(null);

    const { res, promise } = run({ text: 'rain' });
    await promise;

    expect(res._getStatusCode()).toBe(401);
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects an invalid body (422) without resolving a key', async () => {
    const { res, promise } = run({ text: '' }); // fails min(1)
    await promise;

    expect(res._getStatusCode()).toBe(422);
    expect(getApiKey).not.toHaveBeenCalled();
  });

  it('maps an upstream provider failure to 502', async () => {
    getApiKey.mockResolvedValue({ apiKey: 'eleven-key' });
    generate.mockRejectedValue(new Error('ElevenLabs sound generation failed: 429'));

    const { res, promise } = run({ text: 'thunder' });
    await promise;

    expect(res._getStatusCode()).toBe(502);
  });
});
