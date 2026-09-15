import { describe, it, expect, vi, beforeEach } from 'vitest';

// The SQS branch of `handler` is exercised here via the depth-guard "terminate"
// path (checkpointDepth over MAX_CHECKPOINT_DEPTH), which returns before touching
// the session/user/agent-execution pipeline - so this test only needs to stub the
// thin edges (Resource config, WebSocket send, DB connect/markFailed), not the
// full ReActAgent execution machinery.

const benignStub: ProxyHandler<object> = {
  get(_, key) {
    if (key === 'then') return undefined;
    return `mock-${String(key)}`;
  },
};

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get() {
      return new Proxy({}, benignStub);
    },
  }),
}));

vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: class {
    send() {
      return Promise.resolve({});
    }
  },
  PostToConnectionCommand: class {
    constructor(public input: unknown) {}
  },
}));

const mockMarkFailed = vi.fn().mockResolvedValue(undefined);

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  vi.spyOn(actual.agentExecutionRepository, 'markFailed').mockImplementation((...args) => mockMarkFailed(...args));
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
  };
});

function makeSqsEvent(messages: Array<{ messageId: string; body: unknown }>) {
  return {
    Records: messages.map(m => ({ messageId: m.messageId, body: JSON.stringify(m.body) })),
  } as never;
}

// checkpointDepth: 999 exceeds MAX_CHECKPOINT_DEPTH (50), so processExecution
// takes the depth-guard "terminate" branch: markFailed + sendWs + return, all
// before the session/user/agent lookups.
const terminateDepthPayload = {
  executionId: 'exec-1',
  connectionId: 'conn-1',
  checkpointDepth: 999,
};

describe('agentExecutor SQS batch handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports only the failing record in batchItemFailures, still processing the rest', async () => {
    const { handler } = await import('./agentExecutor');
    const event = makeSqsEvent([
      { messageId: 'msg-good', body: terminateDepthPayload },
      // Missing required `connectionId` -> fails ContinuationSchema.parse before
      // processExecution is ever called.
      { messageId: 'msg-bad', body: { executionId: 'exec-2' } },
    ]);

    const result = await handler(event, {} as never);

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'msg-bad' }] });
    expect(mockMarkFailed).toHaveBeenCalledTimes(1);
  });

  it('returns an empty batchItemFailures when every record succeeds', async () => {
    const { handler } = await import('./agentExecutor');
    const event = makeSqsEvent([
      { messageId: 'msg-1', body: { ...terminateDepthPayload, executionId: 'exec-1' } },
      { messageId: 'msg-2', body: { ...terminateDepthPayload, executionId: 'exec-2' } },
    ]);

    const result = await handler(event, {} as never);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockMarkFailed).toHaveBeenCalledTimes(2);
  });
});
