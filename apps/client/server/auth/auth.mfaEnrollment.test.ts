import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks, type RequestMethod } from 'node-mocks-http';
import nc from 'next-connect';

// auth.ts wires every strategy at import time; none of those collaborators are exercised here.
vi.mock('@server/subscriptions/grantIndividualAdminSubscription', () => ({
  grantIndividualAdminSubscription: vi.fn(),
}));
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

// The admin toggle, flipped per test. The decision itself mirrors mfaEnforcement.ts (unit-tested
// there); here it only has to depend on the setting and the user's enrollment.
const enforcement = vi.hoisted(() => ({ enforced: false }));
vi.mock('./mfaEnforcement', () => ({
  isMfaEnrollmentOwed: async (user: { mfa?: { totpEnabled?: boolean } }) =>
    enforcement.enforced && !user.mfa?.totpEnabled,
  MFA_ENROLLMENT_REQUIRED_MESSAGE: 'MFA enrollment required.',
}));

import { auth } from './auth';

type SessionUser = Record<string, unknown>;

/** A full (post-sign-in) session as the JWT strategy sets it: no mfaPending, policies accepted. */
const existingSession = (over: SessionUser = {}): SessionUser => ({
  id: 'u1',
  mfaPending: false,
  aupAcceptedVersion: 'v1',
  ...over,
});

async function call(method: RequestMethod, url: string, user: SessionUser, extra: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method, url }, { eventEmitter: EventEmitter });
  // any: node-mocks-http mocks aren't structurally the Express types the handler is typed against.
  Object.assign(req as any, { user, logger: { info: vi.fn(), updateMetadata: vi.fn() }, ...extra });
  const handlerFn = vi.fn((_req: unknown, response: { status: (code: number) => { end: () => void } }) =>
    response.status(200).end()
  );
  await nc<any, any>().use(auth).all(handlerFn)(req as any, res as any);
  const status = res._getStatusCode();
  return {
    status,
    reached: handlerFn.mock.calls.length === 1,
    body: status === 200 ? undefined : res._getJSONData(),
  };
}

describe('auth middleware: enforceMFA on a session that existed before it was turned on', () => {
  beforeEach(() => {
    enforcement.enforced = false;
  });

  it('serves an unenrolled session while enforcement is off, then blocks it once enforcement turns on', async () => {
    const session = existingSession();
    expect((await call('GET', '/api/quests', session)).reached).toBe(true);

    enforcement.enforced = true;
    const after = await call('GET', '/api/quests', session);

    expect(after.reached).toBe(false);
    // 403, not 401: a 401 would send the client into its refresh cascade, and every refreshed
    // token is refused the same way.
    expect(after.status).toBe(403);
    expect(after.body).toMatchObject({ error: 'MFA enrollment required.', mfaEnrollmentRequired: true });
  });

  it('lets an enrolled user through under enforcement', async () => {
    enforcement.enforced = true;
    expect((await call('GET', '/api/quests', existingSession({ mfa: { totpEnabled: true } }))).reached).toBe(true);
  });

  it.each([
    ['POST', '/api/auth/mfa/setup'],
    ['POST', '/api/auth/mfa/verify-setup'],
    ['POST', '/api/auth/mfa/cancel-setup'],
    ['GET', '/api/auth/mfa/status'],
    ['GET', '/api/settings/fetch'],
    ['GET', '/api/identify'],
    ['GET', '/api/logout'],
    ['POST', '/api/auth/step-up'],
    ['GET', '/api/auth/step-up/options'],
    ['POST', '/api/auth/step-up/email/send'],
    ['GET', '/api/users/u1'],
  ] as const)('still lets the owing session reach %s %s to enroll', async (method, url) => {
    enforcement.enforced = true;
    expect((await call(method, url, existingSession())).reached).toBe(true);
  });

  it.each([
    ['GET', '/api/users/someone-else'],
    ['POST', '/api/users/u1'],
    ['POST', '/api/users/u1/update'],
    ['POST', '/api/auth/mfa/disable'],
    ['GET', '/api/websocket/ticket'],
  ] as const)('blocks the owing session from %s %s', async (method, url) => {
    enforcement.enforced = true;
    const { reached, status } = await call(method, url, existingSession());
    expect(reached).toBe(false);
    expect(status).toBe(403);
  });

  it('lets a user who owes both policy consent and enrollment record consent first', async () => {
    enforcement.enforced = true;
    const unconsented = existingSession({ aupAcceptedVersion: undefined });
    expect((await call('POST', '/api/user/accept-policies', unconsented)).reached).toBe(true);
  });

  it('exempts API-key requests, which are not a sign-in', async () => {
    enforcement.enforced = true;
    const { reached } = await call('GET', '/api/quests', existingSession(), { apiKeyInfo: { scopes: [] } });
    expect(reached).toBe(true);
  });

  it('exempts an admin impersonation session', async () => {
    enforcement.enforced = true;
    expect((await call('GET', '/api/quests', existingSession({ impersonatedBy: 'admin-1' }))).reached).toBe(true);
  });

  it('leaves the mfaPending block in charge of a pending token', async () => {
    enforcement.enforced = true;
    const { status, body } = await call('GET', '/api/quests', existingSession({ mfaPending: true }));
    expect(status).toBe(401);
    expect(body).toMatchObject({ mfaPending: true });
  });
});
