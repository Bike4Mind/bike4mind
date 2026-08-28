// @vitest-environment node
/**
 * Route tests for the public agent-execution endpoints.
 *
 * `baseApi` is stubbed (no DB connect, no auth chain) but `nextRouteForContract` is
 * NOT: the contract's own prelude - path-param validation, body validation, and the
 * non-prod response drift check - runs for real, so a handler response that stops
 * matching the published schema shows up here. What is under test is the part this
 * PR owns: how a `startAgentExecution` outcome maps onto HTTP, and how the internal
 * step shape is projected onto the published one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { AgentExecutionAckSchema, AgentExecutionStatusResponseSchema } from '@bike4mind/common';

const { mockStart, mockLoadTrace } = vi.hoisted(() => ({
  mockStart: vi.fn(),
  mockLoadTrace: vi.fn(),
}));

// Strip the middleware chain but keep next-connect's registrar shape, so
// nextRouteForContract's prelude (validation + drift check) still composes and runs.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const compose =
      (...handlers: ((req: unknown, res: unknown, next: () => void) => unknown)[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of handlers) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = compose;
    chain.post = compose;
    return chain;
  },
}));

vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
vi.mock('@server/utils/startAgentExecution', () => ({ startAgentExecution: mockStart }));
vi.mock('@server/utils/loadAgentExecutionTrace', () => ({ loadAgentExecutionTrace: mockLoadTrace }));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', () => ({ getSettingsMap: async () => ({}), getSettingsValue: () => 'claude-opus-5' }));
vi.mock('@server/utils/chatCompletionDefaults', () => ({
  resolveDefaultChatModel: async () => ({ model: 'default-model' }),
  isChatModelUsable: () => true,
}));

const { default: startHandler } = await import('@pages/api/v1/agent-executions/index');
const { default: getHandler } = await import('@pages/api/v1/agent-executions/[id]/index');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function post(body: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'u1' }, logger });
  return { req, res };
}

function get(id: string) {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  Object.assign(req, { user: { id: 'u1' }, logger });
  return { req, res };
}

/** node-mocks-http surfaces a thrown error only if the caller catches it. */
async function statusOf(run: Promise<unknown>): Promise<number> {
  try {
    await run;
  } catch (err) {
    return (err as { statusCode?: number }).statusCode ?? 500;
  }
  throw new Error('expected the handler to throw');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStart.mockResolvedValue({ ok: true, executionId: 'exec1', questId: 'quest1' });
});

describe('POST /api/v1/agent-executions', () => {
  it('returns a 202 job resource matching the published ack schema', async () => {
    const { req, res } = post({ session_id: 's1', message: 'go' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (startHandler as any)(req, res);

    expect(res._getStatusCode()).toBe(202);
    const body = res._getJSONData();
    expect(AgentExecutionAckSchema.safeParse(body).success).toBe(true);
    expect(body.tracking_info).toEqual({
      execution_id: 'exec1',
      quest_id: 'quest1',
      poll_url: '/api/v1/agent-executions/exec1',
    });
  });

  it('dispatches headless, with the message as the query and the session as the back-reference', async () => {
    const { req, res } = post({ session_id: 's1', message: 'go', max_iterations: 7, tools: ['web_search'] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (startHandler as any)(req, res);

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        sessionId: 's1',
        questId: 's1',
        query: 'go',
        connectionId: 'headless',
        maxIterations: 7,
        enabledTools: ['web_search'],
      }),
      logger
    );
    // No routingSource: the field records which UI signal routed a send to the agent
    // pipeline, and its Quest-schema enum has no value for a direct API call.
    expect(mockStart.mock.calls[0][0]).not.toHaveProperty('routingSource');
  });

  it('falls back to the deployment default model when none is supplied', async () => {
    const { req, res } = post({ session_id: 's1', message: 'go' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (startHandler as any)(req, res);

    expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({ model: 'default-model' }), logger);
    expect(res._getJSONData().model).toBe('default-model');
  });

  it('omits quest_id when the dispatch-time Quest write failed', async () => {
    mockStart.mockResolvedValue({ ok: true, executionId: 'exec1' });
    const { req, res } = post({ session_id: 's1', message: 'go' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (startHandler as any)(req, res);

    expect(res._getJSONData().tracking_info.quest_id).toBeUndefined();
    expect(AgentExecutionAckSchema.safeParse(res._getJSONData()).success).toBe(true);
  });

  it('forwards the requested billing organization for the service to authorize', async () => {
    const { req, res } = post({ session_id: 's1', message: 'go', organization_id: 'org1' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (startHandler as any)(req, res);

    expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org1' }), logger);
  });

  it.each([
    [false, 'an explicit opt-out'],
    [true, 'an explicit opt-in'],
  ] as const)('forwards %s as the caller artifact intent (%s)', async value => {
    const { req, res } = post({ session_id: 's1', message: 'go', enable_artifacts: value });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (startHandler as any)(req, res);

    expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({ enableArtifacts: value }), logger);
  });

  it('leaves the artifact intent absent when the caller omits it, rather than coercing to false', async () => {
    const { req, res } = post({ session_id: 's1', message: 'go' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (startHandler as any)(req, res);

    // Absence must stay absence: `false` is a hard opt-out that strips artifacts even
    // where the deployment wants them, so the admin setting has to remain the only gate.
    // Asserted on the value because `objectContaining` would accept either shape.
    expect(mockStart.mock.calls[0][0].enableArtifacts).toBeUndefined();
  });

  it.each([
    ['session_not_found', 404],
    ['organization_not_found', 404],
    ['concurrent_limit', 409],
    ['dispatch_failed', 502],
  ] as const)('maps a %s outcome to %i', async (reason, status) => {
    mockStart.mockResolvedValue({ ok: false, reason, message: 'nope' });
    const { req, res } = post({ session_id: 's1', message: 'go' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await statusOf((startHandler as any)(req, res))).toBe(status);
  });

  it('rejects a body with no message before dispatching anything', async () => {
    const { req, res } = post({ session_id: 's1' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((startHandler as any)(req, res)).rejects.toThrow();
    expect(mockStart).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/agent-executions/{id}', () => {
  const trace = {
    id: 'exec1',
    status: 'completed' as const,
    sessionId: 's1',
    answer: 'done',
    error: null,
    steps: [
      { type: 'thought' as const, content: 'thinking', metadata: { timestamp: 1, iteration: 0 } },
      { type: 'action' as const, content: 'calling', metadata: { timestamp: 2, iteration: 1, toolName: 'web_search' } },
      { type: 'final_answer' as const, content: 'done' },
    ],
    totalIterations: 2,
    createdAt: new Date('2026-08-24T00:00:00.000Z'),
    updatedAt: new Date('2026-08-24T00:01:00.000Z'),
  };

  it('projects the internal trace onto the published shape', async () => {
    mockLoadTrace.mockResolvedValue(trace);
    const { req, res } = get('exec1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (getHandler as any)(req, res);

    const body = res._getJSONData();
    expect(AgentExecutionStatusResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      id: 'exec1',
      status: 'completed',
      session_id: 's1',
      answer: 'done',
      error: null,
      steps: [
        { type: 'thought', content: 'thinking', iteration: 0 },
        { type: 'action', content: 'calling', iteration: 1, tool_name: 'web_search' },
        { type: 'final_answer', content: 'done' },
      ],
      total_iterations: 2,
      created_at: '2026-08-24T00:00:00.000Z',
      updated_at: '2026-08-24T00:01:00.000Z',
    });
  });

  it('publishes the failure reason so a failed run is not an opaque null answer', async () => {
    mockLoadTrace.mockResolvedValue({
      ...trace,
      status: 'failed' as const,
      answer: null,
      error: 'Execution stopped: tool "delegate_to_agent" requires approval',
    });
    const { req, res } = get('exec1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (getHandler as any)(req, res);

    const body = res._getJSONData();
    expect(AgentExecutionStatusResponseSchema.safeParse(body).success).toBe(true);
    expect(body.status).toBe('failed');
    expect(body.answer).toBeNull();
    expect(body.error).toContain('requires approval');
  });

  it('404s when the run is missing or not visible to the caller', async () => {
    mockLoadTrace.mockResolvedValue(null);
    const { req, res } = get('exec1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await statusOf((getHandler as any)(req, res))).toBe(404);
  });
});
