import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import nc from 'next-connect';

// auth.ts wires every strategy at import time; none of those collaborators are exercised here.
vi.mock('@bike4mind/database', () => ({
  User: { findOne: vi.fn(), updateOne: vi.fn(), create: vi.fn() },
  SamlRequestId: { findOne: vi.fn(), updateOne: vi.fn(), findOneAndDelete: vi.fn() },
  authSessionRepository: { revokeAllByUserId: vi.fn() },
}));
vi.mock('@bike4mind/database/infra', () => ({
  secretRotationRepository: { findBySecretName: vi.fn() },
}));
vi.mock('@server/auth/ability', () => ({ default: vi.fn() }));
vi.mock('@server/utils/config', () => ({
  Config: { GOOGLE_CLIENT_ID: '', GITHUB_CLIENT_ID: '', JWT_SECRET: 'test-secret' },
}));

import { auth } from './auth';

async function requestAsMfaPending(url: string, user: Record<string, unknown> = { aupAcceptedVersion: 'v1' }) {
  const { req, res } = createMocks({ method: 'GET', url }, { eventEmitter: EventEmitter });
  // any: node-mocks-http mocks aren't structurally the Express types the handler is typed against.
  (req as any).user = { id: 'u1', mfaPending: true, ...user };
  const handlerFn = vi.fn((_req: unknown, response: { status: (code: number) => { end: () => void } }) =>
    response.status(200).end()
  );
  await nc<any, any>().use(auth).get(handlerFn)(req as any, res as any);
  return {
    status: res._getStatusCode(),
    blocked: res._getStatusCode() === 401 && res._getJSONData()?.mfaPending === true,
  };
}

describe('auth middleware: mfaPending allowlist', () => {
  it.each([
    '/api/auth/mfa/verify',
    '/api/auth/mfa/verify?attempt=1',
    '/api/auth/mfa/setup',
    '/api/auth/mfa/passkey/authenticate',
    '/api/identify',
    '/api/logout',
    '/api/auth/mfa/verify-setup',
    '/api/auth/mfa/cancel-setup',
    '/api/auth/mfa/status',
    '/api/auth/mfa/passkey/authenticate-options',
    '/api/settings/fetch',
  ])('lets a pending session reach %s', async url => {
    expect((await requestAsMfaPending(url)).blocked).toBe(false);
  });

  it.each([
    '/api/auth/mfa/verify-anything',
    '/api/identify-admin',
    '/api/settings/fetchAll',
    '/api/logout/all',
    '/api/auth/mfa/passkey/abc123',
    '/api/users/u1',
  ])('blocks a pending session from %s, including allowlisted-path prefixes', async url => {
    expect((await requestAsMfaPending(url)).blocked).toBe(true);
  });

  it('lets a new account that has not accepted the policies yet enroll its required factor', async () => {
    // Without the exemption the consent gate 403s setup, while the policy route is unreachable
    // to a pending token: the account could never finish its first sign-in.
    expect((await requestAsMfaPending('/api/auth/mfa/setup', {})).status).toBe(200);
  });

  it('still enforces the policy gate on a full session that has not accepted the policies', async () => {
    // The consent exemption is only for mfaPending tokens: a verified session with no recorded
    // acceptance is refused (403) on a route outside the consent allowlist.
    const { status, blocked } = await requestAsMfaPending('/api/settings/fetch', {
      mfaPending: false,
      aupAcceptedVersion: undefined,
    });
    expect(blocked).toBe(false);
    expect(status).toBe(403);
  });

  it('lets a full session that accepted the policies reach the same route', async () => {
    const { status } = await requestAsMfaPending('/api/settings/fetch', {
      mfaPending: false,
      aupAcceptedVersion: 'v1',
    });
    expect(status).toBe(200);
  });

  it('keeps a pending token off non-allowlisted routes even without accepted policies', async () => {
    const { blocked } = await requestAsMfaPending('/api/users/u1', { aupAcceptedVersion: undefined });
    expect(blocked).toBe(true);
  });
});
