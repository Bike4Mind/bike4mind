// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  findByUserCode: vi.fn(),
  findByDeviceCode: vi.fn(),
  recordPollIfDue: vi.fn(),
  claimApproved: vi.fn(),
  transition: vi.fn(),
  decrementCounter: vi.fn(),
  user: vi.fn(),
  issue: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => {
  type Chain = { use: () => Chain; post: (handler: unknown) => unknown };
  const chain: Chain = { use: () => chain, post: handler => handler };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => {} }));
vi.mock('@server/utils/apiKeyAccessGate', () => ({
  isApiKeyAccessAllowed: mocks.access,
  CLI_ACCESS_DENIED_MESSAGE: 'The CLI and desktop app require an active paid subscription',
  SUBSCRIPTION_REQUIRED_ERROR: 'subscription_required',
}));
vi.mock('@server/utils/oauth/deviceAuthHelpers', () => ({
  LIVE_PENDING_COUNTER_KEY: 'device-pending',
  MAX_LIVE_PENDING_DEVICE_AUTHORIZATIONS: 100,
}));
vi.mock('@server/auth/issueSession', () => ({ issueSessionForRequest: mocks.issue }));
vi.mock('@server/auth/tokenGenerator', () => ({ ACCESS_TOKEN_TTL_SECONDS: 1800 }));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: async () => ({ success: true }),
    decrementCounter: mocks.decrementCounter,
  },
  deviceAuthorizationRepository: {
    findByUserCode: mocks.findByUserCode,
    findByDeviceCode: mocks.findByDeviceCode,
    recordPollIfDue: mocks.recordPollIfDue,
    claimApproved: mocks.claimApproved,
  },
  DeviceAuthorizationModel: { findOneAndUpdate: mocks.transition },
  userRepository: { findById: mocks.user },
}));

import verifyHandler from '../../../pages/api/oauth/device/verify';
import tokenHandler from '../../../pages/api/oauth/device/token';

const user = { id: 'user-1', tokenVersion: 7 };
const authorization = (clientId: string | undefined, status = 'pending') => ({
  id: 'device-1',
  clientId,
  status,
  userId: user.id,
  verificationAttempts: 0,
  expiresAt: new Date(Date.now() + 600_000),
  createdAt: new Date(),
  ipAddress: '127.0.0.1',
});
const invoke = async (handler: unknown, body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user });
  await (handler as (request: unknown, response: unknown) => Promise<unknown>)(req, res);
  return { req, res };
};
const tokenBody = (clientId: string) => ({
  grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  device_code: 'secret-code',
  client_id: clientId,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue(true);
  mocks.transition.mockResolvedValue({});
  mocks.recordPollIfDue.mockResolvedValue(true);
  mocks.claimApproved.mockResolvedValue({});
  mocks.user.mockResolvedValue(user);
  mocks.issue.mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh' });
});

describe.each(['b4m-cli', 'b4m-desktop', undefined])('device access policy (%s)', clientId => {
  it('refuses approval before changing pending state or counters', async () => {
    mocks.findByUserCode.mockResolvedValue(authorization(clientId));
    mocks.access.mockResolvedValue(false);
    const { req, res } = await invoke(verifyHandler, { user_code: 'ABCD', action: 'approve' });
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toBe('subscription_required');
    expect(mocks.access).toHaveBeenCalledWith(user, undefined, req);
    expect(mocks.transition).not.toHaveBeenCalled();
    expect(mocks.decrementCounter).not.toHaveBeenCalled();
  });

  it('allows eligible approval and permits a denied user to reject a device', async () => {
    mocks.findByUserCode.mockResolvedValue(authorization(clientId));
    const approved = await invoke(verifyHandler, { user_code: 'ABCD', action: 'approve' });
    expect(approved.res._getStatusCode()).toBe(200);
    expect(mocks.transition).toHaveBeenLastCalledWith(
      { _id: 'device-1', status: 'pending' },
      { $set: expect.objectContaining({ status: 'approved', userId: user.id }) },
      { new: false }
    );
    mocks.access.mockClear().mockResolvedValue(false);
    const denied = await invoke(verifyHandler, { user_code: 'ABCD', action: 'deny' });
    expect(denied.res._getStatusCode()).toBe(200);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.transition).toHaveBeenLastCalledWith(
      { _id: 'device-1', status: 'pending' },
      { $set: expect.objectContaining({ status: 'denied', userId: null }) },
      { new: false }
    );
  });

  it('rechecks access before claiming an approved code and minting tokens', async () => {
    mocks.findByDeviceCode.mockResolvedValue(authorization(clientId, 'approved'));
    mocks.access.mockResolvedValue(false);
    const { req, res } = await invoke(tokenHandler, tokenBody(clientId ?? 'b4m-cli'));
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toBe('subscription_required');
    expect(mocks.access).toHaveBeenCalledWith(user, undefined, req);
    expect(mocks.claimApproved).not.toHaveBeenCalled();
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it('issues eligible sessions with their original device client provenance', async () => {
    mocks.findByDeviceCode.mockResolvedValue(authorization(clientId, 'approved'));
    const { req, res } = await invoke(tokenHandler, tokenBody(clientId ?? 'b4m-cli'));
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.issue).toHaveBeenCalledWith(req, user.id, {
      createdVia: 'device',
      tokenVersion: 7,
      clientId: clientId ?? 'b4m-cli',
    });
  });
});

it.each(['approval', 'issuance'])('fails closed on an access lookup outage during %s', async phase => {
  mocks.access.mockRejectedValue(new Error('subscription lookup unavailable'));
  mocks.findByUserCode.mockResolvedValue(authorization('b4m-cli'));
  mocks.findByDeviceCode.mockResolvedValue(authorization('b4m-cli', 'approved'));
  await expect(
    phase === 'approval'
      ? invoke(verifyHandler, { user_code: 'ABCD', action: 'approve' })
      : invoke(tokenHandler, tokenBody('b4m-cli'))
  ).rejects.toThrow('subscription lookup unavailable');
  expect(mocks.transition).not.toHaveBeenCalled();
  expect(mocks.claimApproved).not.toHaveBeenCalled();
  expect(mocks.issue).not.toHaveBeenCalled();
});
