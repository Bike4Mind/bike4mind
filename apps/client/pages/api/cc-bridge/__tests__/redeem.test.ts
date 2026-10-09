import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { mockRoute, type RouteHandler } from './testUtils';

const refs = vi.hoisted(() => ({
  post: null as null | RouteHandler,
  rateLimitOpts: null as null | { limit: number; windowMs: number },
  findCandidates: vi.fn(),
  redeemToken: vi.fn(),
  createDevice: vi.fn(),
  createKey: vi.fn(),
  apiKeyUpdateOne: vi.fn(),
  deviceDeleteOne: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    post: (fn: RouteHandler) => {
      refs.post = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: (opts: { limit: number; windowMs: number }) => {
    refs.rateLimitOpts = opts;
    return () => undefined;
  },
}));
vi.mock('@bike4mind/database', () => ({
  CcBridgeDevice: { deleteOne: refs.deviceDeleteOne },
  agentRepository: {},
  ccBridgeDeviceRepository: { create: refs.createDevice },
  ccBridgePairingTokenRepository: {
    findUnredeemedCandidatesByPrefix: refs.findCandidates,
    redeem: refs.redeemToken,
  },
}));
vi.mock('@bike4mind/database/auth', () => ({
  UserApiKey: { updateOne: refs.apiKeyUpdateOne },
  userApiKeyRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ userApiKeyService: { createUserApiKey: refs.createKey } }));

import { ApiKeyScope } from '@bike4mind/common';
import '../redeem';

const TOKEN = `b4mpair_${'a'.repeat(32)}`;
const OTHER_TOKEN = `b4mpair_${'a'.repeat(8)}${'b'.repeat(24)}`;
let tokenHash: string;

const record = (over: Record<string, unknown> = {}) => ({
  _id: 'tok-1',
  userId: 'owner-1',
  tokenHash,
  tokenPrefix: TOKEN.substring(0, 16),
  platform: 'darwin-arm64',
  ...over,
});

const redeem = async (body: unknown, headers?: Record<string, string>) => {
  const { req, res } = mockRoute({ body, headers });
  await refs.post!(req, res);
  return res;
};

const validBody = { pairingToken: TOKEN, deviceLabel: 'laptop' };

describe('POST /api/cc-bridge/redeem', () => {
  beforeAll(async () => {
    tokenHash = await bcrypt.hash(TOKEN, 4);
  });

  beforeEach(() => {
    Object.values(refs).forEach(v => typeof v === 'function' && 'mockReset' in v && v.mockReset());
    refs.findCandidates.mockResolvedValue([record()]);
    refs.createKey.mockResolvedValue({ id: 'key-1', key: 'b4m_plain', keyPrefix: 'b4m_plai' });
    refs.createDevice.mockResolvedValue({ _id: 'dev-1', deviceLabel: 'laptop' });
    refs.redeemToken.mockResolvedValue({ _id: 'tok-1' });
  });

  it('is an unauthenticated route guarded by a per-IP rate limit', () => {
    expect(refs.rateLimitOpts).toEqual({ limit: 20, windowMs: 60_000 });
  });

  it('redeems a valid token for a CC_BRIDGE-only key bound to the token owner', async () => {
    const res = await redeem({ ...validBody, bridgeVersion: '1.2.3' }, { 'x-forwarded-for': '1.1.1.1, 9.9.9.9' });

    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData()).toEqual({
      deviceId: 'dev-1',
      deviceLabel: 'laptop',
      userId: 'owner-1',
      apiKey: 'b4m_plain',
      apiKeyPrefix: 'b4m_plai',
    });

    const [ownerId, keyInput] = refs.createKey.mock.calls[0];
    expect(ownerId).toBe('owner-1');
    expect(keyInput.scopes).toEqual([ApiKeyScope.CC_BRIDGE]);
    expect(keyInput.metadata.clientIP).toBe('9.9.9.9');
    expect(refs.createDevice.mock.calls[0][0]).toMatchObject({
      userId: 'owner-1',
      apiKeyId: 'key-1',
      platform: 'darwin-arm64',
      bridgeVersion: '1.2.3',
    });
    expect(refs.redeemToken).toHaveBeenCalledWith('tok-1', 'dev-1');
  });

  it('is single-use: a second redeem finds no unredeemed candidate and mints nothing', async () => {
    refs.findCandidates.mockResolvedValueOnce([record()]).mockResolvedValueOnce([]);

    expect((await redeem(validBody))._getStatusCode()).toBe(201);
    const second = await redeem(validBody);

    expect(second._getStatusCode()).toBe(401);
    expect(refs.createKey).toHaveBeenCalledTimes(1);
    expect(refs.createDevice).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired token (repository returns no candidates) without minting', async () => {
    refs.findCandidates.mockResolvedValue([]);
    const res = await redeem(validBody);
    expect(res._getStatusCode()).toBe(401);
    expect(refs.createKey).not.toHaveBeenCalled();
  });

  it('rolls back the key and device when it loses a concurrent redemption race', async () => {
    refs.redeemToken.mockResolvedValue(null);
    const res = await redeem(validBody);

    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData().apiKey).toBeUndefined();
    expect(refs.apiKeyUpdateOne).toHaveBeenCalledWith(
      { _id: 'key-1' },
      expect.objectContaining({
        $set: expect.objectContaining({ status: expect.anything(), revokedAt: expect.any(Date) }),
      })
    );
    expect(refs.deviceDeleteOne).toHaveBeenCalledWith({ _id: 'dev-1' });
  });

  it('rejects a token that shares a prefix with a stored one but is not the real token', async () => {
    const res = await redeem({ ...validBody, pairingToken: OTHER_TOKEN });
    expect(res._getStatusCode()).toBe(401);
    expect(refs.createKey).not.toHaveBeenCalled();
  });

  it('never redeems a token against another user: the key goes to the matched record owner only', async () => {
    const otherHash = await bcrypt.hash(OTHER_TOKEN, 4);
    refs.findCandidates.mockResolvedValue([
      record({ _id: 'tok-other', userId: 'victim-1', tokenHash: otherHash }),
      record(),
    ]);
    const res = await redeem(validBody);
    expect(res._getStatusCode()).toBe(201);
    expect(refs.createKey.mock.calls[0][0]).toBe('owner-1');
    expect(refs.redeemToken).toHaveBeenCalledWith('tok-1', 'dev-1');
  });

  it('does not let the caller choose the owner via a userId in the body', async () => {
    await redeem({ ...validBody, userId: 'victim-1', scopes: ['admin'] });
    expect(refs.createKey.mock.calls[0][0]).toBe('owner-1');
    expect(refs.createKey.mock.calls[0][1].scopes).toEqual([ApiKeyScope.CC_BRIDGE]);
  });

  it('does not reveal the owner userId on a failed redeem', async () => {
    refs.findCandidates.mockResolvedValue([record({ tokenHash: await bcrypt.hash('different-token-value', 4) })]);
    const res = await redeem(validBody);
    expect(res._getStatusCode()).toBe(401);
    expect(res._getData()).not.toContain('owner-1');
  });

  it.each([
    ['no body', undefined],
    ['a missing token', { deviceLabel: 'laptop' }],
    ['a too-short token', { pairingToken: 'short', deviceLabel: 'laptop' }],
    ['an oversized token', { pairingToken: 'x'.repeat(201), deviceLabel: 'laptop' }],
    ['a missing label', { pairingToken: TOKEN }],
    ['an empty label', { pairingToken: TOKEN, deviceLabel: '' }],
    ['a label with a newline', { pairingToken: TOKEN, deviceLabel: 'ok\nnext' }],
    ['a label with a tab', { pairingToken: TOKEN, deviceLabel: 'ok\tnext' }],
    ['a label with HTML', { pairingToken: TOKEN, deviceLabel: '<img src=x>' }],
    ['an oversized label', { pairingToken: TOKEN, deviceLabel: 'l'.repeat(101) }],
    ['an oversized platform', { ...validBody, platform: 'p'.repeat(51) }],
    ['an oversized bridgeVersion', { ...validBody, bridgeVersion: 'v'.repeat(31) }],
    ['a non-string token', { pairingToken: { $ne: '' }, deviceLabel: 'laptop' }],
  ])('rejects %s with 400 before touching the database', async (_name, body) => {
    const res = await redeem(body);
    expect(res._getStatusCode()).toBe(400);
    expect(refs.findCandidates).not.toHaveBeenCalled();
    expect(refs.createKey).not.toHaveBeenCalled();
  });
});
