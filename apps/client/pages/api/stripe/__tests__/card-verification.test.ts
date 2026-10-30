// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  options: null as unknown,
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<unknown>>,
  begin: vi.fn(),
  finish: vi.fn(),
  offer: vi.fn(),
  runtime: vi.fn(),
  network: vi.fn(),
  resumable: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    mocks.options = options;
    const chain = {
      use: () => chain,
      get: (fn: typeof mocks.handlers.get) => {
        mocks.handlers.get = fn;
        return chain;
      },
      post: (fn: typeof mocks.handlers.post) => {
        mocks.handlers.post = fn;
        return chain;
      },
      delete: (fn: typeof mocks.handlers.delete) => {
        mocks.handlers.delete = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => () => {} }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { STRIPE_PUBLISHABLE_KEY: 'synthetic-public' } }));
vi.mock('@server/auth/networkMeta', () => ({ readNetworkMeta: mocks.network }));
vi.mock('@server/billing/cardVerificationLifecycle', () => ({ beginCardVerification: mocks.begin }));
vi.mock('@server/billing/cardVerificationRuntime', async () => ({
  cardNetworkDigest: () => 'synthetic-digest',
  cardVerificationRuntime: mocks.runtime,
  finishCardVerification: mocks.finish,
  resumableVerificationSecret: mocks.resumable,
  verificationOffer: mocks.offer,
  verificationIdSchema: (await import('zod')).z.string().uuid(),
  verificationFailure: (error: unknown) => {
    throw error;
  },
}));
import '../card-verification';
const id = '00000000-0000-4000-8000-000000000001';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.network.mockReturnValue({ ip: '192.0.2.1', asn: 64512 });
  mocks.runtime.mockResolvedValue({ synthetic: true });
  mocks.begin.mockResolvedValue({ verificationId: id, clientSecret: 'synthetic-secret' });
});
const request = (body: unknown) => {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, { body, user: { id: 'synthetic-owner' } });
  return { req, res };
};
describe('verification route', () => {
  it('accepts JWT only', () => {
    expect(mocks.options).toEqual({ auth: 'jwtOnly' });
  });
  it('binds setup to the authenticated user and trusted network, ignoring client identity/amount', async () => {
    const { req, res } = request({
      turnstileToken: 'synthetic-token',
      credits: 999,
      fingerprint: 'untrusted',
      userId: 'other',
      ip: 'untrusted',
    });
    await mocks.handlers.post(req, res);
    expect(mocks.begin).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'synthetic-owner', ip: '192.0.2.1', asn: '64512' }),
      false,
      { synthetic: true }
    );
    expect(res._getJSONData()).toMatchObject({ verificationId: id, publishableKey: 'synthetic-public' });
  });
  it('does not create a setup without a challenge', async () => {
    const { req, res } = request({});
    await expect(mocks.handlers.post(req, res)).rejects.toThrow();
    expect(mocks.begin).not.toHaveBeenCalled();
  });
  it('passes authenticated ownership on completion and removal', async () => {
    const { req, res } = request({ verificationId: id, userId: 'other' });
    mocks.finish.mockResolvedValue('granted');
    await mocks.handlers.post(req, res);
    expect(mocks.finish).toHaveBeenCalledWith(id, 'synthetic-owner');
    const removal = request({ verificationId: id });
    await mocks.handlers.delete(removal.req, removal.res);
    expect(mocks.finish).toHaveBeenCalledWith(id, 'synthetic-owner', true);
    expect(mocks.resumable).not.toHaveBeenCalled();
  });
  it('reports a verification another worker is finishing as pending instead of failing', async () => {
    mocks.finish.mockResolvedValue('busy');
    const { req, res } = request({ verificationId: id });
    await mocks.handlers.post(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ outcome: 'pending' });
    expect(mocks.resumable).not.toHaveBeenCalled();
    const removal = request({ verificationId: id });
    await mocks.handlers.delete(removal.req, removal.res);
    expect(removal.res._getStatusCode()).toBe(409);
    expect(removal.res._getJSONData()).toEqual({ error: expect.stringContaining('still being processed') });
  });
  it('returns the owner setup secret only for a resumable pending verification', async () => {
    mocks.finish.mockResolvedValue('pending');
    mocks.resumable.mockResolvedValueOnce('synthetic-secret');
    const resumable = request({ verificationId: id });
    await mocks.handlers.post(resumable.req, resumable.res);
    expect(mocks.resumable).toHaveBeenCalledWith(id, 'synthetic-owner');
    expect(resumable.res._getJSONData()).toEqual({
      outcome: 'pending',
      clientSecret: 'synthetic-secret',
      publishableKey: 'synthetic-public',
    });
    mocks.resumable.mockResolvedValueOnce(null);
    const processing = request({ verificationId: id });
    await mocks.handlers.post(processing.req, processing.res);
    expect(processing.res._getJSONData()).toEqual({ outcome: 'pending' });
  });
});
