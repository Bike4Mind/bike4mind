import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import nc from 'next-connect';
import passport from 'passport';
import type { Request, Response } from 'express';

// auth.ts registers the OAuth strategies at import time, so the configured branch needs its own file.
vi.mock('@bike4mind/server-utils/utils/organizationAudit', () => ({
  recordOrganizationAuditEvent: vi.fn(),
  recordOrganizationAuditEventSafe: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/auth/riskEvidence', () => ({
  requestRiskEvidenceRefresh: vi.fn(async () => 'queued'),
}));
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
vi.mock('@bike4mind/server-utils/auth/ability', () => ({ default: vi.fn(() => 'ability') }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: {
    GOOGLE_CLIENT_ID: 'google-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    GITHUB_CLIENT_ID: 'github-id',
    GITHUB_CLIENT_SECRET: 'github-secret',
    JWT_SECRET: 'test-secret',
  },
}));
vi.mock('./appleStrategy', () => ({ registerAppleStrategy: vi.fn(() => true) }));
vi.mock('@bike4mind/server-utils/auth/mfaEnforcement', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/auth/mfaEnforcement')>()),
  isMfaEnrollmentOwed: vi.fn(async () => false),
}));
vi.mock('@bike4mind/server-utils/auth/consentGate', () => ({ isPolicyConsentRequired: () => false }));

import { auth } from './auth';

type JwtCallback = (err: Error | null, user: Express.User | false) => void;

async function runAuth(outcome: { err: Error | null; user: Express.User | false }, preset: object = {}) {
  vi.spyOn(passport, 'authenticate').mockImplementation(
    ((_name: string, _opts: object, cb: JwtCallback) => () =>
      cb(outcome.err, outcome.user)) as unknown as typeof passport.authenticate
  );
  const { req, res } = createMocks({ method: 'GET', url: '/api/v1/me' }, { eventEmitter: EventEmitter });
  Object.assign(req, preset);
  const handlerFn = vi.fn((_req: Request, r: Response) => r.status(200).end());
  const route = nc<Request, Response>({ onError: (err, _req, r) => r.status(500).json({ error: err.message }) })
    .use(auth)
    .get(handlerFn);
  // node-mocks-http objects stand in for the Express request and response auth.ts declares.
  const expressReq = req as unknown as Request;
  await route(expressReq, res as unknown as Response);
  return { req: expressReq, res, handlerFn };
}

describe('auth.ts with the OAuth providers configured', () => {
  it('registers the Google and GitHub strategies', () => {
    // Passport's strategy registry is private and untyped.
    const registry = passport as unknown as { _strategy(name: string): unknown };
    expect(registry._strategy('google')).toBeDefined();
    expect(registry._strategy('github')).toBeDefined();
  });

  it('passes a strategy error on', async () => {
    const { res, handlerFn } = await runAuth({ err: new Error('jwt broke'), user: false });

    expect(handlerFn).not.toHaveBeenCalled();
    expect(res._getStatusCode()).toBe(500);
  });

  it('attaches the user and its ability, keeping a logger already on the request', async () => {
    const logger = { updateMetadata: vi.fn() };
    const { req, handlerFn } = await runAuth({ err: null, user: { id: 'u1' } as Express.User }, { logger });

    expect(handlerFn).toHaveBeenCalled();
    expect(req.user).toEqual({ id: 'u1' });
    expect(req.logger).toBe(logger);
    expect(logger.updateMetadata).toHaveBeenCalledWith({ userId: 'u1' });
    expect(req.ability).toBe('ability');
  });

  it('keeps an ability already on the request', async () => {
    const { req } = await runAuth({ err: null, user: { id: 'u2' } as Express.User }, { ability: 'preset' });

    expect(req.ability).toBe('preset');
  });
});
