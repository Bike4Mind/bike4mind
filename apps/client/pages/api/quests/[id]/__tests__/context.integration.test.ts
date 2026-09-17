// @vitest-environment node
/**
 * Integration test for GET /api/quests/[id]/context.
 *
 * Drives the real handler through the middleware chain `baseApi` assembles, so the ownership gate,
 * the telemetry-level gate and the whitelist are all exercised as the route actually runs them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockQuestFindById, mockSessionFindById, currentUser } = vi.hoisted(() => ({
  mockQuestFindById: vi.fn(),
  mockSessionFindById: vi.fn(),
  currentUser: {
    value: {} as { id: string; preferences?: { contextTelemetryLevel?: 'none' | 'basic' | 'enhanced' } },
  },
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    questRepository: {
      ...(actual.questRepository as object),
      findById: (...a: unknown[]) => mockQuestFindById(...a),
    },
    sessionRepository: {
      ...(actual.sessionRepository as object),
      findById: (...a: unknown[]) => mockSessionFindById(...a),
    },
  };
});

vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
    auth: (req: any, _res: any, next: any) => {
      req.user = { ...currentUser.value, _id: currentUser.value.id, isBanned: false, disputePending: false };
      next();
    },
  };
});

import handler from '../context';

const PROMPT_META = {
  generatedAt: '2026-09-16T10:00:00.000Z',
  model: { name: 'claude-opus-4-8', contextWindow: 200000, parameters: { maxTokens: 8192 } },
  tokenUsage: { inputTokens: 7040, outputTokens: 512, cacheReadInputTokens: 6000, settledBasis: 'provider' },
  retrieval: { attempted: true, outcome: 'ok', surfaces: ['forced'], dataLakeTags: ['ionq'] },
  offeredTools: ['search_knowledge_base'],
  functionCalls: [{ name: 'search_knowledge_base', success: true, executionTime: 120, returnValue: 'SECRET-RETURN' }],
  contextTelemetry: { anonymousSessionId: { hash: 'SECRET-HASH' } },
  context: {
    systemPrompt: 'SECRET-SYSTEM',
    userPrompt: 'SECRET-USER',
    tokensBySource: {
      systemPrompts: 4000,
      conversationHistory: 1200,
      mementos: 0,
      fabFiles: 0,
      urlContent: 0,
      toolSchemas: 900,
      userPrompt: 40,
    },
    systemPromptDetails: [
      { source: 'admin', name: 'artifact_emission', tokenCount: 2822, wasIncluded: true },
      { source: 'hardcoded', name: 'date_time_context', tokenCount: 60, wasIncluded: true },
    ],
  },
};

function fire() {
  const { req, res } = createMocks(
    { method: 'GET', url: '/api/quests/quest-1/context', query: { id: 'quest-1' } },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http mocks aren't structurally the Express Request/Response types.
  return { req: req as any, res: res as any };
}

describe('GET /api/quests/[id]/context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser.value = { id: 'owner', preferences: { contextTelemetryLevel: 'basic' } };
    mockQuestFindById.mockResolvedValue({ id: 'quest-1', sessionId: 'sess-1', promptMeta: PROMPT_META });
    mockSessionFindById.mockResolvedValue({ id: 'sess-1', userId: 'owner', users: [{ userId: 'sharee' }] });
  });

  it('returns the breakdown to the quest owner', async () => {
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      questId: 'quest-1',
      capturedAt: '2026-09-16T10:00:00.000Z',
      model: { id: 'claude-opus-4-8' },
      categories: { systemPrompt: 2882, systemPromptResidual: 4000, toolDefinitions: 900 },
      layers: [
        { source: 'hardcoded', name: 'date_time_context', tokenCount: 60, wasIncluded: true },
        { source: 'admin', name: 'artifact_emission', tokenCount: 2822, wasIncluded: true },
      ],
      tools: [{ name: 'search_knowledge_base', offered: true, invocations: 1, successes: 1, durationMs: 120 }],
      retrieval: { attempted: true, outcome: 'ok' },
      cache: { readTokens: 6000, writeTokens: 0, settledBasis: 'provider' },
      window: { contextWindow: 200000, inputTokens: 7040, maxOutputTokens: 8192, freeSpace: 184768 },
    });
    expect(res._getJSONData().promptFingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it('never returns prompt text, tool output or the telemetry document', async () => {
    const { req, res } = fire();
    await handler(req, res);

    const body = JSON.stringify(res._getJSONData());
    expect(body).not.toContain('SECRET-SYSTEM');
    expect(body).not.toContain('SECRET-USER');
    expect(body).not.toContain('SECRET-RETURN');
    expect(body).not.toContain('SECRET-HASH');
    expect(body).not.toContain('contextTelemetry');
  });

  it('404s a share holder - reading the conversation is not auditing its assembly', async () => {
    currentUser.value = { id: 'sharee', preferences: { contextTelemetryLevel: 'basic' } };
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
  });

  it('404s a user with no relationship to the session', async () => {
    currentUser.value = { id: 'stranger', preferences: { contextTelemetryLevel: 'basic' } };
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
  });

  it('404s an unknown quest', async () => {
    mockQuestFindById.mockResolvedValue(null);
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(404);
  });

  it('403s with an explanation when the user set their telemetry level to none', async () => {
    currentUser.value = { id: 'owner', preferences: { contextTelemetryLevel: 'none' } };
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/telemetry level is None/i);
    expect(mockQuestFindById).not.toHaveBeenCalled();
  });

  it('treats an unset telemetry level as basic', async () => {
    currentUser.value = { id: 'owner' };
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
  });

  it('returns an empty but complete breakdown for a quest recorded before the context fields existed', async () => {
    mockQuestFindById.mockResolvedValue({
      id: 'quest-1',
      sessionId: 'sess-1',
      promptMeta: { model: { name: 'gpt-4' } },
    });
    const { req, res } = fire();
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      questId: 'quest-1',
      layers: [],
      tools: [],
      retrieval: null,
      categories: { systemPrompt: 0, systemPromptResidual: 0 },
      window: { contextWindow: null, freeSpace: null },
      promptFingerprint: '',
    });
  });
});
