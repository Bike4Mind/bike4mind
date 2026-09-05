import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * `previousKey` is a secret the JWT verifier trusts inside the rotation grace
 * window, so it must only ever come from the server's own configuration.
 */

const mockRefs = vi.hoisted(() => ({
  putHandler: null as null | ((req: any, res: any) => unknown),
  postHandler: null as null | ((req: any, res: any) => unknown),
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
    };
    return chain;
  },
}));

const mockUpdate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 's1' }));
const mockFindById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/infra', () => ({
  SecretRotation: {},
  secretRotationRepository: {
    update: (...a: unknown[]) => mockUpdate(...a),
    findById: (...a: unknown[]) => mockFindById(...a),
  },
}));

vi.mock('@server/utils/config', () => ({
  Config: { JWT_SECRET: 'server-held-jwt-secret' },
}));

import '../[id]/index';
import '../renewed';

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
