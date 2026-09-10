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
import { Types } from 'mongoose';

const USER_A = 'user-a';
const USER_B = 'user-b';
const SESSION_ID = '507f1f77bcf86cd799439011'; // valid ObjectId owned by user B below

const {
  mockFindById,
  mockFindRotation,
  mockSessionFindById,
  mockTryIncrement,
  mockQuestFindById,
  mockGetSettingsValue,
  mockGetAttachedAgents,
  mockDetachAgent,
  mockAgentFindAccessibleById,
  mockAutoName,
  mockGetOperationsModel,
  mockQuestCreate,
} = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockFindRotation: vi.fn(),
  mockSessionFindById: vi.fn(),
  mockTryIncrement: vi.fn(),
  mockQuestFindById: vi.fn(),
  mockGetSettingsValue: vi.fn(),
  mockGetAttachedAgents: vi.fn(),
  mockDetachAgent: vi.fn(),
  mockAgentFindAccessibleById: vi.fn(),
  mockAutoName: vi.fn(),
  mockGetOperationsModel: vi.fn(),
  mockQuestCreate: vi.fn(),
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
      getAttachedAgents: (...a: unknown[]) => mockGetAttachedAgents(...a),
      detachAgent: (...a: unknown[]) => mockDetachAgent(...a),
    },
    agentRepository: {
      ...(actual.agentRepository as object),
      shareable: {
        ...((actual.agentRepository as { shareable?: object })?.shareable ?? {}),
        findAccessibleById: (...a: unknown[]) => mockAgentFindAccessibleById(...a),
      },
    },
    Quest: Object.assign(Object.create(actual.Quest as object), {
      create: (...a: unknown[]) => mockQuestCreate(...a),
    }),
    questRepository: {
      ...(actual.questRepository as object),
      findById: (...a: unknown[]) => mockQuestFindById(...a),
    },
    adminSettingsRepository: {
      ...(actual.adminSettingsRepository as object),
      getSettingsValue: (...a: unknown[]) => mockGetSettingsValue(...a),
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

// auto-rename's positive control reaches the LLM chain past the guard; stub those two edges so an
// owned-session request completes deterministically instead of hitting real model config.
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: (...a: unknown[]) => mockGetOperationsModel(...a) },
}));
vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    sessionService: {
      ...(actual.sessionService as object),
      autoName: (...a: unknown[]) => mockAutoName(...a),
    },
  };
});

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
      // Distinct from `id` (a real ObjectId) so a `.id` -> `._id` mutation in any route becomes a
      // deny-everyone gate and fails the positive controls below, instead of passing because the
      // two held the same string.
      _id: new Types.ObjectId('507f1f77bcf86cd799439099'),
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
    // A quest whose session is B's - used by the rapid-reply questId branch.
    mockQuestFindById.mockResolvedValue({ _id: 'quest-b', sessionId: SESSION_ID });
    // RapidReply feature off by default, so the owned-session positive control returns early.
    mockGetSettingsValue.mockResolvedValue(false);
    // Downstream stubs for the owned-session positive controls (each route's business logic past
    // the session guard). The denial cases never reach these - the guard 404s first.
    mockGetAttachedAgents.mockResolvedValue([]);
    mockDetachAgent.mockResolvedValue({ id: SESSION_ID, userId: USER_A, name: 'S' });
    mockAgentFindAccessibleById.mockResolvedValue(null);
    mockAutoName.mockResolvedValue({ id: SESSION_ID, userId: USER_A, name: 'Renamed' });
    mockGetOperationsModel.mockResolvedValue({ modelId: 'op-model', llm: { complete: vi.fn() } });
    mockQuestCreate.mockResolvedValue({ _id: 'quest-new', sessionId: SESSION_ID, replies: ['You rolled a 20'] });
  });

  // Assert the error BODY, not just the status: the POST agents route has a second
  // NotFoundError('Agent not found') just past the guard, so a bare-404 assertion would still pass
  // if the session guard were deleted and the agent lookup stubbed. 'Session not found' proves the
  // denial came from the session guard.
  it("GET /api/sessions/[id]/agents -> 404 (not B's agents)", async () => {
    const { req, res } = fire('GET', `/api/sessions/${SESSION_ID}/agents`, undefined, { id: SESSION_ID });
    await agentsHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData().error).toBe('Session not found');
  });

  it("POST /api/sessions/[id]/agents -> 404 (cannot attach to B's session)", async () => {
    const { req, res } = fire('POST', `/api/sessions/${SESSION_ID}/agents`, { agentId: 'agent-1' }, { id: SESSION_ID });
    await agentsHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData().error).toBe('Session not found');
  });

  it("DELETE /api/sessions/[id]/agents -> 404 (cannot detach from B's session)", async () => {
    const { req, res } = fire(
      'DELETE',
      `/api/sessions/${SESSION_ID}/agents`,
      { agentId: 'agent-1' },
      { id: SESSION_ID }
    );
    await agentsHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData().error).toBe('Session not found');
  });

  it("POST /api/sessions/[id]/auto-rename -> 404 (cannot rename B's session)", async () => {
    const { req, res } = fire('POST', `/api/sessions/${SESSION_ID}/auto-rename`, {}, { id: SESSION_ID });
    await autoRenameHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData().error).toBe('Session not found');
  });

  it("POST /api/roll -> 404 (cannot write a quest into B's session)", async () => {
    const { req, res } = fire('POST', '/api/roll', { diceSpec: '1d20', sessionId: SESSION_ID });
    await rollHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData().error).toBe('Session not found');
  });

  it("POST /api/ai/rapid-reply -> 404 (cannot plant a rapid reply on B's session)", async () => {
    const { req, res } = fire('POST', '/api/ai/rapid-reply', {
      sessionId: SESSION_ID,
      message: 'hello',
      model: 'some-model',
    });
    await rapidReplyHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData().error).toBe('Session not found');
  });

  // P1-2 regression: dropping sessionId must NOT skip the guard. With only a questId that resolves
  // to B's session, the handler must still gate on that session and deny.
  it('POST /api/ai/rapid-reply with only a questId (no sessionId) -> 404 (gate falls back to the quest session)', async () => {
    const { req, res } = fire('POST', '/api/ai/rapid-reply', {
      questId: 'quest-b',
      message: 'hello',
      model: 'some-model',
    });
    await rapidReplyHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData().error).toBe('Session not found');
  });

  // A nonexistent questId and an existing-but-forbidden one must return the SAME 404 body, so quest
  // existence is not a probing oracle: both surface as 'Session not found'.
  it('POST /api/ai/rapid-reply with a questId that resolves to nothing -> 404 Session not found (no existence oracle)', async () => {
    mockQuestFindById.mockResolvedValue(null);
    const { req, res } = fire('POST', '/api/ai/rapid-reply', {
      questId: 'ghost',
      message: 'hello',
      model: 'some-model',
    });
    await rapidReplyHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData().error).toBe('Session not found');
  });

  // Positive control through the real chain: on the caller's OWN session the guard passes and the
  // request reaches business logic (RapidReply is disabled here, so a 200 {reason:'disabled'}). A
  // guard that denied everyone would 404 this too.
  it('POST /api/ai/rapid-reply on the caller-owned session -> 200 (guard passes, no over-denial)', async () => {
    mockSessionFindById.mockResolvedValue({ _id: SESSION_ID, userId: USER_A, users: [] });
    const { req, res } = fire('POST', '/api/ai/rapid-reply', {
      sessionId: SESSION_ID,
      message: 'hello',
      model: 'some-model',
    });
    await rapidReplyHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().reason).toBe('disabled');
  });

  // Positive controls for the remaining routes: a guard that denied everyone (e.g. `req.user!._id`
  // instead of `.id`) passes every denial test above, so each route needs one owned-session case
  // that reaches business logic past the guard.
  it('GET /api/sessions/[id]/agents on the caller-owned session -> 200 (guard passes)', async () => {
    mockSessionFindById.mockResolvedValue({ _id: SESSION_ID, userId: USER_A, users: [] });
    const { req, res } = fire('GET', `/api/sessions/${SESSION_ID}/agents`, undefined, { id: SESSION_ID });
    await agentsHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().agents).toEqual([]);
  });

  it('POST /api/sessions/[id]/agents on the caller-owned session -> past the session guard (404 Agent not found)', async () => {
    // Guard passes on the owned session; the 404 now comes from the agent lookup, not the session
    // guard - a distinct error body proving the request reached business logic.
    mockSessionFindById.mockResolvedValue({ _id: SESSION_ID, userId: USER_A, users: [] });
    const { req, res } = fire('POST', `/api/sessions/${SESSION_ID}/agents`, { agentId: 'agent-1' }, { id: SESSION_ID });
    await agentsHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData().error).toBe('Agent not found');
  });

  it('DELETE /api/sessions/[id]/agents on the caller-owned session -> 200 (guard passes)', async () => {
    mockSessionFindById.mockResolvedValue({ _id: SESSION_ID, userId: USER_A, users: [] });
    const { req, res } = fire(
      'DELETE',
      `/api/sessions/${SESSION_ID}/agents`,
      { agentId: 'agent-1' },
      { id: SESSION_ID }
    );
    await agentsHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
  });

  it('POST /api/sessions/[id]/auto-rename on the caller-owned session -> 200 (guard passes)', async () => {
    mockSessionFindById.mockResolvedValue({ _id: SESSION_ID, userId: USER_A, users: [] });
    const { req, res } = fire('POST', `/api/sessions/${SESSION_ID}/auto-rename`, {}, { id: SESSION_ID });
    await autoRenameHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
  });

  // Read-vs-write discrimination: session B shared to A read-only (a users[] entry with no
  // 'update' permission). A read route passes; a write route denies. If any write route reverted
  // to the default 'read' level, the rapid-reply leg here would flip to 200 and fail.
  it('read-only sharee: GET agents -> 200 but POST rapid-reply -> 404 (write needs an update grant)', async () => {
    mockSessionFindById.mockResolvedValue({
      _id: SESSION_ID,
      userId: USER_B,
      users: [{ userId: USER_A, permissions: [] }],
    });
    const get = fire('GET', `/api/sessions/${SESSION_ID}/agents`, undefined, { id: SESSION_ID });
    await agentsHandler(get.req, get.res);
    expect(get.res._getStatusCode()).toBe(200);

    const post = fire('POST', '/api/ai/rapid-reply', { sessionId: SESSION_ID, message: 'hi', model: 'm' });
    await rapidReplyHandler(post.req, post.res);
    expect(post.res._getStatusCode()).toBe(404);
    expect(post.res._getJSONData().error).toBe('Session not found');
  });

  // Positive control for POST /api/roll: on the caller's OWN session the write gate passes and the
  // request reaches Quest.create. A deny-everyone mutation would 404 this.
  it('POST /api/roll on the caller-owned session -> 200 (guard passes, no over-denial)', async () => {
    mockSessionFindById.mockResolvedValue({ _id: SESSION_ID, userId: USER_A, users: [] });
    const { req, res } = fire('POST', '/api/roll', { diceSpec: '1d20', sessionId: SESSION_ID });
    await rollHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
  });
});
