import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The per-member cap gate in `processSubagentDispatch` must fire `onDagNodeTerminal`
// on refusal: without it, a capped-out member's DAG children ALL fail this gate (it's
// a per-user condition, so it trips uniformly for every sibling) and NONE would wake
// the parent - a permanent hang, since `cleanupStaleActive` deliberately excludes
// `awaiting_dag_children` from its sweep. Drives the real `handler` through a
// `dag_node_dispatch` message and asserts the hook still fires on this refusal path.

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

function dagNodeDispatchEvent() {
  return makeSqsEvent([
    {
      messageId: 'msg-1',
      body: { kind: 'dag_node_dispatch', childExecutionId: 'child-1', connectionId: 'conn-1', dagNodeId: 'node-b' },
    },
  ]);
}

describe('agentExecutor DAG-node refusal paths fire onDagNodeTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onDagNodeTerminalMock.mockClear();
  });

  it('fires the hook on the per-member cap refusal so the parent is not left wedged', async () => {
    const { handler } = await import('./agentExecutor');

    const result = await handler(dagNodeDispatchEvent(), {} as never);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockMarkFailed).toHaveBeenCalledWith('child-1', { message: 'Organization member credit limit reached' });
    expect(onDagNodeTerminalMock).toHaveBeenCalledTimes(1);
    expect(onDagNodeTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        child: expect.objectContaining({ id: 'child-1', dagNodeId: 'node-b', status: 'failed' }),
      })
    );
  });

  it('fires the hook on a session-ownership refusal too, via the same shared helper', async () => {
    // Ownership is checked before the org-pool/member-cap gates, so this fires
    // first regardless of the child's organizationId.
    const { sessionRepository } = await import('@bike4mind/database');
    vi.mocked(sessionRepository.findById).mockResolvedValueOnce({ id: 'session-1', userId: 'someone-else' } as never);

    const { handler } = await import('./agentExecutor');
    await handler(dagNodeDispatchEvent(), {} as never);

    expect(mockMarkFailed).toHaveBeenCalledWith('child-1', { message: 'Session ownership validation failed' });
    expect(onDagNodeTerminalMock).toHaveBeenCalledTimes(1);
    expect(onDagNodeTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({ child: expect.objectContaining({ id: 'child-1', status: 'failed' }) })
    );
  });

  it('does NOT fire the hook when another Lambda already claimed the child (CAS loss)', async () => {
    const { agentExecutionRepository } = await import('@bike4mind/database');
    vi.mocked(agentExecutionRepository.claimExecution).mockResolvedValueOnce(false as never);

    const { handler } = await import('./agentExecutor');
    await handler(dagNodeDispatchEvent(), {} as never);

    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(onDagNodeTerminalMock).not.toHaveBeenCalled();
  });

  it('fires the hook from the outer catch when an unexpected downstream error escapes every other handler', async () => {
    // dagNodeId is hoisted right after the child doc loads, well before this call, so the
    // outer catch - which has no access to `child` - should still have it available. This is
    // the exit with the least direct test coverage and the most machinery between it and the
    // hook call, per three review rounds each catching a different missed exit in this file.
    const { sessionRepository } = await import('@bike4mind/database');
    vi.mocked(sessionRepository.findById).mockRejectedValueOnce(new Error('Mongo blip'));

    const { handler } = await import('./agentExecutor');
    await handler(dagNodeDispatchEvent(), {} as never);

    expect(mockMarkFailed).toHaveBeenCalledWith('child-1', { message: 'Mongo blip', timedOut: false });
    expect(onDagNodeTerminalMock).toHaveBeenCalledTimes(1);
    expect(onDagNodeTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        child: expect.objectContaining({ id: 'child-1', dagNodeId: 'node-b', status: 'failed' }),
      })
    );
  });
});

describe('buildInProcessCreditCapCheck', () => {
  it('re-fetches organization on every call, so it reflects credits billed since the calling entry-gate snapshot', async () => {
    const notYetCapped = { id: 'org-1', maxCreditsPerMember: 5, userDetails: [{ id: 'user-1', usedCredits: 4 }] };
    const nowCapped = { id: 'org-1', maxCreditsPerMember: 5, userDetails: [{ id: 'user-1', usedCredits: 5 }] };
    const findById = vi
      .fn()
      .mockResolvedValueOnce(notYetCapped as never)
      .mockResolvedValueOnce(nowCapped as never);

    const { buildInProcessCreditCapCheck } = await import('./agentExecutor');
    const check = buildInProcessCreditCapCheck({ findById }, 'org-1', 'user-1');

    expect(await check()).toBe(false);
    expect(await check()).toBe(true);
    expect(findById).toHaveBeenCalledTimes(2);
    expect(findById).toHaveBeenCalledWith('org-1');
  });

  it('returns false without a DB read when there is no organizationId', async () => {
    const findById = vi.fn();
    const { buildInProcessCreditCapCheck } = await import('./agentExecutor');
    const check = buildInProcessCreditCapCheck({ findById }, undefined, 'user-1');

    expect(await check()).toBe(false);
    expect(findById).not.toHaveBeenCalled();
  });
});

describe('checkMemberCreditCap wiring sites', () => {
  // buildInProcessCreditCapCheck's own re-fetch behavior is unit tested above, but nothing
  // stops a future edit from reverting a call site to an inline closure over the stale
  // `organization` snapshot - the exact bug a human reviewer caught in this same PR. A source
  // scan is crude, but it directly guards the regression class the wiring itself can't:
  // both sites must call the shared helper, and neither may reintroduce the old pattern.
  const source = readFileSync(join(__dirname, 'agentExecutor.ts'), 'utf-8');

  it('wires both the top-level and dispatched-subagent sites through buildInProcessCreditCapCheck', () => {
    const wiringSites = source.match(/checkMemberCreditCap:\s*buildInProcessCreditCapCheck\(/g) ?? [];
    expect(wiringSites).toHaveLength(2);
  });

  it('does not reintroduce a closure over the stale organization snapshot', () => {
    expect(source).not.toMatch(/checkMemberCreditCap: \(\) =>\s*\n\s*Boolean\(organization/);
  });
});
