// @vitest-environment node
/**
 * Object-level authorization regression test.
 *
 * Each route here acts on a caller-supplied session id. Before the fix they
 * trusted the id as-is, so user A could read/write user B's session or quest
 * (IDOR). This drives the REAL next-connect chain baseApi() assembles with a
 * genuinely-signed token for user A, stubs sessionRepository.findById to return
 * a session owned by user B, and asserts every route denies the cross-tenant
 * request instead of acting on B's data. Only the data edges are stubbed
 * (connectDB, the User lookup, the rate-limit cache, the session read).
 *
 * Modeled on ../sessions/__tests__/auth-behavior.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import jwt from 'jsonwebtoken';

const USER_A = 'user-a';
const USER_B = 'user-b';
const SESSION_ID = '507f1f77bcf86cd799439011'; // valid ObjectId owned by user B below

const { mockFindById, mockFindRotation, mockSessionFindById, mockTryIncrement } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockFindRotation: vi.fn(),
  mockSessionFindById: vi.fn(),
  mockTryIncrement: vi.fn(),
}));

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindById(...a) }),
    sessionRepository: {
      ...(actual.sessionRepository as object),
      findById: (...a: unknown[]) => mockSessionFindById(...a),
    },
    cacheRepository: {
      ...(actual.cacheRepository as object),
      tryIncrementWithinLimitFixedWindow: (...a: unknown[]) => mockTryIncrement(...a),
    },
  };
});

vi.mock('@bike4mind/database/infra', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    secretRotationRepository: {
      ...(actual.secretRotationRepository as object),
      findByKeyName: (...a: unknown[]) => mockFindRotation(...a),
    },
  };
});

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/analytics/analyticsMiddleware', () => ({
  analyticsMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import agentsHandler from '../sessions/[id]/agents';
import autoRenameHandler from '../sessions/[id]/auto-rename';
import rollHandler from '../roll';
import rapidReplyHandler from '../ai/rapid-reply';
import { Config } from '@server/utils/config';

if (!Config.JWT_SECRET) throw new Error('JWT_SECRET not provisioned in test env');
const REAL_SECRET = String(Config.JWT_SECRET);

function tokenForA() {
  return jwt.sign({ id: USER_A, tokenVersion: 0 }, REAL_SECRET, { algorithm: 'HS256', expiresIn: '7d' });
}

function fire(method: 'GET' | 'POST' | 'DELETE', url: string, body?: object, query: Record<string, string> = {}) {
  const { req, res } = createMocks(
    {
      method,
      url,
      query,
      body,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${tokenForA()}`,
      },
    },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http req/res aren't structurally the Express types the chain is typed for.
  return { req: req as any, res: res as any };
}

describe('object-level authz: user A cannot act on user B session/quest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindRotation.mockResolvedValue(null);
    mockTryIncrement.mockResolvedValue({ success: true, expiresAt: new Date(Date.now() + 60_000) });
    // Authenticated user A: consented, non-system, current token version.
    mockFindById.mockResolvedValue({
      id: USER_A,
      _id: USER_A,
      isSystem: false,
      isBanned: false,
      disputePending: false,
      aupAcceptedVersion: 'grandfathered',
      tokenVersion: 0,
      tags: [],
      isAdmin: false,
      roles: [],
    });
    // The target session is owned by user B and not shared with A.
    mockSessionFindById.mockResolvedValue({ _id: SESSION_ID, userId: USER_B, users: [] });
  });

  it("GET /api/sessions/[id]/agents -> 404 (not B's agents)", async () => {
    const { req, res } = fire('GET', `/api/sessions/${SESSION_ID}/agents`, undefined, { id: SESSION_ID });
    await agentsHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
  });

  it("POST /api/sessions/[id]/agents -> 404 (cannot attach to B's session)", async () => {
    const { req, res } = fire('POST', `/api/sessions/${SESSION_ID}/agents`, { agentId: 'agent-1' }, { id: SESSION_ID });
    await agentsHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
  });

  it("POST /api/sessions/[id]/auto-rename -> 404 (cannot rename B's session)", async () => {
    const { req, res } = fire('POST', `/api/sessions/${SESSION_ID}/auto-rename`, {}, { id: SESSION_ID });
    await autoRenameHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
  });

  it("POST /api/roll -> 404 (cannot write a quest into B's session)", async () => {
    const { req, res } = fire('POST', '/api/roll', { diceSpec: '1d20', sessionId: SESSION_ID });
    await rollHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
  });

  it("POST /api/ai/rapid-reply -> 404 (cannot plant a rapid reply on B's session)", async () => {
    const { req, res } = fire('POST', '/api/ai/rapid-reply', {
      sessionId: SESSION_ID,
      message: 'hello',
      model: 'some-model',
    });
    await rapidReplyHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
  });
});
