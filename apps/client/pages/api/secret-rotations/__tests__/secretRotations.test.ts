import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * `previousKey` is a secret the JWT verifier trusts inside the rotation grace
 * window, so it must only ever come from the server's own configuration.
 */

const mockRefs = vi.hoisted(() => ({
  putHandler: null as null | ((req: any, res: any) => unknown),
  postHandler: null as null | ((req: any, res: any) => unknown),
  getHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: any = {
      use: () => chain,
      put: (fn: any) => {
        mockRefs.putHandler = fn;
        return chain;
      },
      post: (fn: any) => {
        mockRefs.postHandler = fn;
        return chain;
      },
      get: (fn: any) => {
        mockRefs.getHandler = fn;
        return chain;
      },
    };
    return chain;
  },
}));

const mockUpdate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 's1' }));
const mockFindById = vi.hoisted(() => vi.fn());
const mockFindActive = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockCreate = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/infra', () => ({
  SecretRotation: {},
  secretRotationRepository: {
    update: (...a: unknown[]) => mockUpdate(...a),
    findById: (...a: unknown[]) => mockFindById(...a),
    findActiveKeys: (...a: unknown[]) => mockFindActive(...a),
    create: (...a: unknown[]) => mockCreate(...a),
  },
}));

vi.mock('@server/utils/config', () => ({
  Config: { JWT_SECRET: 'server-held-jwt-secret' },
}));

import '../[id]/index';
import '../renewed';
import '../index';

function request(body: unknown) {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as any).ability = { can: () => true };
  (req as any).user = { id: 'admin-1', name: 'Admin' };
  return { req, res };
}

describe('PUT /api/secret-rotations/:id', () => {
  beforeEach(() => mockUpdate.mockClear());

  it('drops a caller-supplied previousKey instead of storing it', async () => {
    const { req, res } = request({ id: 's1', previousKey: 'attacker-chosen', description: 'db' });
    await mockRefs.putHandler!(req, res);

    expect(mockUpdate).toHaveBeenCalledWith({ id: 's1', description: 'db' });
    expect(mockUpdate.mock.calls[0][0]).not.toHaveProperty('previousKey');
  });

  it('still accepts the fields an operator legitimately edits', async () => {
    const { req, res } = request({ id: 's1', rotationIntervalDays: 45 });
    await mockRefs.putHandler!(req, res);

    expect(mockUpdate).toHaveBeenCalledWith({ id: 's1', rotationIntervalDays: 45 });
  });

  it('returns the safe shape, never the raw document (no previousKey, no mongo internals)', async () => {
    // The list and renew responses go through toSafeSecretRotation; this route must too,
    // so a future secret-ish field on the schema does not leak here and nowhere else.
    mockUpdate.mockResolvedValueOnce({
      id: 's1',
      keyName: 'JWT_SECRET',
      previousKey: 'server-held-jwt-secret',
      rotatedAt: new Date(),
      nextRotation: new Date(),
      rotationIntervalDays: 30,
      isActive: true,
      _id: 'mongo-id',
      __v: 3,
      deletedAt: null,
    });
    const { req, res } = request({ id: 's1', rotationIntervalDays: 30 });
    await mockRefs.putHandler!(req, res);

    const body = res._getJSONData();
    expect(body).not.toHaveProperty('previousKey');
    expect(body).not.toHaveProperty('__v');
    expect(body).not.toHaveProperty('_id');
    expect(JSON.stringify(body)).not.toContain('server-held-jwt-secret');
    expect(body.keyName).toBe('JWT_SECRET');
  });

  it('404s an unknown secret instead of serializing null', async () => {
    mockUpdate.mockResolvedValueOnce(null);
    const { req, res } = request({ id: 'nope' });
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow(/not found/i);
  });
});

describe('POST /api/secret-rotations/renewed', () => {
  beforeEach(() => {
    mockUpdate.mockClear();
    mockUpdate.mockResolvedValue({ id: 's1' });
  });

  it('captures previousKey from the secret the server itself holds', async () => {
    mockFindById.mockResolvedValue({ id: 's1', keyName: 'JWT_SECRET', rotationIntervalDays: 30 });
    const { req, res } = request({ id: 's1' });
    await mockRefs.postHandler!(req, res);

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1', previousKey: 'server-held-jwt-secret' })
    );
  });

  it('re-captures on every renew, so the grace window advances rather than extending a stale key', async () => {
    mockFindById.mockResolvedValue({ id: 's1', keyName: 'JWT_SECRET', rotationIntervalDays: 30 });
    const first = request({ id: 's1' });
    await mockRefs.postHandler!(first.req, first.res);
    const firstRotatedAt = mockUpdate.mock.calls[0][0].rotatedAt;

    const second = request({ id: 's1' });
    await mockRefs.postHandler!(second.req, second.res);
    const secondCall = mockUpdate.mock.calls[1][0];

    expect(secondCall.previousKey).toBe('server-held-jwt-secret');
    expect(secondCall.rotatedAt.getTime()).toBeGreaterThanOrEqual(firstRotatedAt.getTime());
  });

  it('stores previousKey encrypted at rest, recoverable by the grace-window verifiers', async () => {
    const { configureSecretsAtRest, decryptAtRest, generateEncryptionKey } = await import('@bike4mind/utils/security');
    configureSecretsAtRest(generateEncryptionKey());
    try {
      mockFindById.mockResolvedValue({ id: 's1', keyName: 'JWT_SECRET', rotationIntervalDays: 30 });
      const { req, res } = request({ id: 's1' });
      await mockRefs.postHandler!(req, res);

      const stored = mockUpdate.mock.calls[0][0].previousKey as string;
      // Never the plaintext signing secret at rest, but the verifiers can still recover it.
      expect(stored).not.toBe('server-held-jwt-secret');
      expect(decryptAtRest(stored)).toBe('server-held-jwt-secret');
    } finally {
      configureSecretsAtRest(undefined);
    }
  });

  it('leaves previousKey unset for secrets no verifier reads it for', async () => {
    mockFindById.mockResolvedValue({ id: 's2', keyName: 'STRIPE_SECRET_KEY', rotationIntervalDays: 90 });
    const { req, res } = request({ id: 's2' });
    await mockRefs.postHandler!(req, res);

    expect(mockUpdate.mock.calls[0][0].previousKey).toBeUndefined();
  });

  it('404s an unknown secret without touching the record', async () => {
    mockFindById.mockResolvedValue(null);
    const { req, res } = request({ id: 'nope' });
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(/not found/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('403s a caller without update permission', async () => {
    const { req, res } = request({ id: 's1' });
    (req as any).ability = { can: () => false };
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('previousKey never reaches a response', () => {
  beforeEach(() => {
    mockUpdate.mockClear();
    mockFindActive.mockClear();
  });

  it('strips previousKey from the renew response even when the repo hands it back', async () => {
    mockFindById.mockResolvedValue({ id: 's1', keyName: 'JWT_SECRET', rotationIntervalDays: 30 });
    // A stored document round-trips the field; the response must not.
    mockUpdate.mockResolvedValue({
      id: 's1',
      keyName: 'JWT_SECRET',
      previousKey: 'server-held-jwt-secret',
      rotatedAt: new Date(),
      nextRotation: new Date(),
      rotationIntervalDays: 30,
      isActive: true,
    });

    const { req, res } = request({ id: 's1' });
    await mockRefs.postHandler!(req, res);

    const body = res._getJSONData();
    expect(body).not.toHaveProperty('previousKey');
    expect(JSON.stringify(body)).not.toContain('server-held-jwt-secret');
    expect(body.keyName).toBe('JWT_SECRET');
  });

  it('strips previousKey from the list response', async () => {
    mockFindActive.mockResolvedValue([
      {
        id: 's1',
        keyName: 'JWT_SECRET',
        previousKey: 'server-held-jwt-secret',
        rotatedAt: new Date(),
        nextRotation: new Date(),
        rotationIntervalDays: 30,
        isActive: true,
      },
    ]);

    const { req, res } = request({});
    await mockRefs.getHandler!(req, res);

    const body = res._getJSONData();
    expect(JSON.stringify(body)).not.toContain('server-held-jwt-secret');
    expect(body[0]).not.toHaveProperty('previousKey');
    expect(body[0].keyName).toBe('JWT_SECRET');
  });
});
