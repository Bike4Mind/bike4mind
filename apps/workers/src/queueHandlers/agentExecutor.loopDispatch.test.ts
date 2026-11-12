import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A loop run's end asks for the loop's next run (requestLoopDispatch) from processExecution's `finally`.
 * Exercised through the aborted-before-start exit, which enters the try and returns before any agent work;
 * every other exit leaves through the same `finally`.
 */

vi.mock('@server/utils/thinkingVisibility', () => ({ resolveThinkingVisibility: vi.fn(async () => 'raw') }));
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  createModelAdmission: async () => ({ admits: async () => true, assert: async () => {} }),
}));

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

const h = vi.hoisted(() => ({ requestLoopDispatch: vi.fn(), findById: vi.fn() }));
vi.mock('@server/utils/loopDispatch', () => ({ requestLoopDispatch: h.requestLoopDispatch, pushLoopChanged: vi.fn() }));
vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  vi.spyOn(actual.agentExecutionRepository, 'findById').mockImplementation((...args) => h.findById(...args));
  vi.spyOn(actual.agentExecutionRepository, 'markAborted').mockResolvedValue(undefined as never);
  return { ...actual, connectDB: vi.fn().mockResolvedValue(undefined) };
});

const start = { executionId: 'exec-1', connectionId: 'conn-1' };

describe('agentExecutor loop run end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks for the loop's next run when a loop run ends", async () => {
    h.findById.mockResolvedValue({ id: 'exec-1', loopId: 'loop-1', abortedAt: new Date() });
    const { handler } = await import('./agentExecutor');

    await handler({ Records: [{ messageId: 'm1', body: JSON.stringify(start) }] } as never, {} as never);

    expect(h.requestLoopDispatch).toHaveBeenCalledWith('loop-1', expect.anything());
  });

  it('asks nothing for a run outside a loop', async () => {
    h.findById.mockResolvedValue({ id: 'exec-1', abortedAt: new Date() });
    const { handler } = await import('./agentExecutor');

    await handler({ Records: [{ messageId: 'm1', body: JSON.stringify(start) }] } as never, {} as never);

    expect(h.requestLoopDispatch).not.toHaveBeenCalled();
  });
});
