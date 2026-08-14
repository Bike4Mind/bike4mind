import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression test for the per-member cap gate added to `processSubagentDispatch`:
// a human review on PR #1777 found the gate returned without firing
// `onDagNodeTerminal`, so a capped-out member's DAG children would ALL fail this
// gate (it's a per-user condition, so it trips uniformly for every sibling) and
// NONE would wake the parent - a permanent hang, since `cleanupStaleActive`
// deliberately excludes `awaiting_dag_children` from its sweep. This test drives
// the real `handler` through a `dag_node_dispatch` message and asserts the hook
// still fires on this refusal path.

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

const onDagNodeTerminalMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./agentExecutorDag', async () => {
  const actual = await vi.importActual<typeof import('./agentExecutorDag')>('./agentExecutorDag');
  return { ...actual, onDagNodeTerminal: (...args: unknown[]) => onDagNodeTerminalMock(...args) };
});

const childDoc = {
  id: 'child-1',
  status: 'pending',
  abortedAt: null,
  userId: 'user-1',
  sessionId: 'session-1',
  organizationId: 'org-1',
  parentExecutionId: 'parent-1',
  dagNodeId: 'node-b',
  subagentConfig: { agentName: 'researcher', thoroughness: 'quick' },
};

const capOrg = {
  id: 'org-1',
  currentCredits: 1000,
  maxCreditsPerMember: 5,
  userDetails: [{ id: 'user-1', usedCredits: 50 }],
};

const mockMarkFailed = vi.fn().mockResolvedValue(undefined);

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  vi.spyOn(actual.agentExecutionRepository, 'findById').mockResolvedValue(childDoc as never);
  vi.spyOn(actual.agentExecutionRepository, 'claimExecution').mockResolvedValue(true as never);
  vi.spyOn(actual.agentExecutionRepository, 'updateConnectionId').mockResolvedValue(undefined as never);
  vi.spyOn(actual.agentExecutionRepository, 'markFailed').mockImplementation((...args) => mockMarkFailed(...args));
  vi.spyOn(actual.User, 'findById').mockResolvedValue({ id: 'user-1', currentCredits: 100 } as never);
  vi.spyOn(actual.sessionRepository, 'findById').mockResolvedValue({ id: 'session-1', userId: 'user-1' } as never);
  vi.spyOn(actual.organizationRepository, 'findById').mockResolvedValue(capOrg as never);
  return { ...actual, connectDB: vi.fn().mockResolvedValue(undefined) };
});

function makeSqsEvent(messages: Array<{ messageId: string; body: unknown }>) {
  return {
    Records: messages.map(m => ({ messageId: m.messageId, body: JSON.stringify(m.body) })),
  } as never;
}

describe('agentExecutor per-member cap gate on dispatched DAG nodes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fires onDagNodeTerminal so the parent is not left wedged in awaiting_dag_children', async () => {
    const { handler } = await import('./agentExecutor');
    const event = makeSqsEvent([
      {
        messageId: 'msg-1',
        body: { kind: 'dag_node_dispatch', childExecutionId: 'child-1', connectionId: 'conn-1', dagNodeId: 'node-b' },
      },
    ]);

    const result = await handler(event, {} as never);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockMarkFailed).toHaveBeenCalledWith('child-1', { message: 'Organization member credit limit reached' });
    expect(onDagNodeTerminalMock).toHaveBeenCalledTimes(1);
    expect(onDagNodeTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        child: expect.objectContaining({ id: 'child-1', dagNodeId: 'node-b', status: 'failed' }),
      })
    );
  });
});
