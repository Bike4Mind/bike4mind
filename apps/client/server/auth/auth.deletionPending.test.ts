import { describe, it, expect, vi } from 'vitest';
vi.mock('@server/auth/riskEvidence', () => ({ requestRiskEvidenceRefresh: vi.fn(async () => 'queued') }));
import { EventEmitter } from 'events';
import { createMocks, type RequestMethod } from 'node-mocks-http';
import nc from 'next-connect';
import { ACCOUNT_DELETION_PENDING_CODE } from '@bike4mind/common';

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
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { GOOGLE_CLIENT_ID: '', GITHUB_CLIENT_ID: '', JWT_SECRET: 'test-secret' },
}));
vi.mock('@bike4mind/server-utils/auth/mfaEnforcement', () => ({
  isMfaEnrollmentOwed: async () => false,
  MFA_ENROLLMENT_REQUIRED_MESSAGE: 'MFA enrollment required.',
}));

import { auth } from './auth';

const scheduledFor = new Date('2026-11-17T00:00:00.000Z');
const frozen = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  mfaPending: false,
  aupAcceptedVersion: 'v1',
  deletion: { requestedAt: new Date('2026-11-03T00:00:00.000Z'), scheduledFor, source: 'self' },
  ...over,
});

async function call(method: RequestMethod, url: string, user: Record<string, unknown>) {
  const { req, res } = createMocks({ method, url }, { eventEmitter: EventEmitter });
  // any: node-mocks-http mocks aren't structurally the Express types the handler is typed against.
  Object.assign(req as any, { user, requestId: 'req-1', logger: { info: vi.fn(), updateMetadata: vi.fn() } });
  const handlerFn = vi.fn((_req: unknown, response: { status: (code: number) => { end: () => void } }) =>
    response.status(200).end()
  );
  await nc<any, any>().use(auth).all(handlerFn)(req as any, res as any);
  return {
    status: res._getStatusCode(),
    reached: handlerFn.mock.calls.length === 1,
    body: res._isJSON() ? res._getJSONData() : undefined,
  };
}

describe('auth middleware: account in its deletion grace period', () => {
  it.each([
    ['GET', '/api/quests'],
    ['POST', '/api/ai/v1/completions'],
    ['POST', '/api/email/change'],
    ['POST', '/api/mcp-connections'],
    ['GET', '/api/users/someone-else'],
    ['POST', '/api/account/deletion'],
  ] as const)('refuses %s %s with 403 ACCOUNT_DELETION_PENDING', async (method, url) => {
    const { status, reached, body } = await call(method, url, frozen());
    expect(reached).toBe(false);
    expect(status).toBe(403);
    expect(body.code).toBe(ACCOUNT_DELETION_PENDING_CODE);
    expect(new Date(body.scheduledFor).toISOString()).toBe(scheduledFor.toISOString());
  });

  it.each([
    ['GET', '/api/account/deletion'],
    ['DELETE', '/api/account/deletion'],
    ['GET', '/api/identify'],
    ['GET', '/api/logout'],
    ['GET', '/api/users/u1'],
  ] as const)('lets the cancel screen reach %s %s', async (method, url) => {
    const { reached } = await call(method, url, frozen());
    expect(reached).toBe(true);
  });

  it('does not touch an account with no pending deletion', async () => {
    const { reached } = await call('GET', '/api/quests', frozen({ deletion: undefined }));
    expect(reached).toBe(true);
  });

  it('leaves an mfaPending token to its own allowlist', async () => {
    const { status, body } = await call('POST', '/api/auth/mfa/verify', frozen({ mfaPending: true }));
    expect(status).toBe(200);
    expect(body?.code).toBeUndefined();
  });
});
