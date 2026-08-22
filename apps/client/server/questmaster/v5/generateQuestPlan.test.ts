import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IQuestGraphDocument } from '@bike4mind/common';

/**
 * The orchestration around `planShape`: the planning claim, the empty-graph
 * refusal, the model gate, the failure taxonomy (400 for a model's fault, 500
 * for ours), the metering, and the all-or-nothing write.
 *
 * `planShape` is pure and covered separately; everything here is the part that
 * spends money and writes to Mongo.
 */

const claimForPlanning = vi.fn();
const releasePlanningClaim = vi.fn();
const addRootNode = vi.fn();
const getNodes = vi.fn();
const addNode = vi.fn();
const deleteNode = vi.fn();
const recordSessionOperationalUsage = vi.fn();
const getAvailableModels = vi.fn();
const getLlmByModel = vi.fn();
const complete = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  apiKeyRepository: {},
  questGraphRepository: {
    claimForPlanning: (...a: unknown[]) => claimForPlanning(...a),
    releasePlanningClaim: (...a: unknown[]) => releasePlanningClaim(...a),
    addRootNode: (...a: unknown[]) => addRootNode(...a),
  },
  questNodeRepository: {
    getNodes: (...a: unknown[]) => getNodes(...a),
    addNode: (...a: unknown[]) => addNode(...a),
    delete: (...a: unknown[]) => deleteNode(...a),
  },
}));

vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: async () => ({}) },
}));

vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: (...a: unknown[]) => getAvailableModels(...a),
  getLlmByModel: (...a: unknown[]) => getLlmByModel(...a),
  resolveDeprecatedModelId: (id: string) => id,
}));

vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: async () => ({}) }));

vi.mock('@server/events/recordSessionOperationalUsage', () => ({
  recordSessionOperationalUsage: (...a: unknown[]) => recordSessionOperationalUsage(...a),
}));

const { generateQuestPlan } = await import('./generateQuestPlan');

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const graph = (over: Partial<IQuestGraphDocument> = {}): IQuestGraphDocument =>
  ({
    id: 'g1',
    goal: 'ship the thing',
    userId: 'u1',
    sessionId: 's1',
    rootNodeIds: [],
    state: 'draft',
    visibility: 'private',
    budget: { maxDepth: 5, maxNodes: 200 },
    ...over,
  }) as IQuestGraphDocument;

/** A minimal well-formed plan: two phases, one task each. */
const PLAN = JSON.stringify({
  phases: [
    { title: 'One', objective: 'first', tasks: [{ title: 'a', task: 'do a' }] },
    { title: 'Two', objective: 'second', tasks: [{ title: 'b', task: 'do b' }] },
  ],
});

const USAGE = { inputTokens: 100, outputTokens: 200 };

/** The streaming callback shape `llm.complete` invokes. */
type CompleteCallback = (texts: (string | null | undefined)[], usage?: unknown) => Promise<void>;

/** Drive the completion callback with a canned reply, in one chunk. */
const replyWith = (text: string, usage: unknown = USAGE) =>
  complete.mockImplementation(async (_m: string, _msgs: unknown, _o: unknown, cb: CompleteCallback) => {
    await cb([text], usage);
  });

const run = (over: Partial<IQuestGraphDocument> = {}) =>
  generateQuestPlan({ graph: graph(over), userId: 'u1', model: 'gpt-5', logger });

beforeEach(() => {
  vi.clearAllMocks();
  claimForPlanning.mockResolvedValue(graph());
  releasePlanningClaim.mockResolvedValue(undefined);
  addRootNode.mockResolvedValue(null);
  getNodes.mockResolvedValue([]);
  let n = 0;
  addNode.mockImplementation(async () => ({ id: `n${++n}` }));
  deleteNode.mockResolvedValue(undefined);
  getAvailableModels.mockResolvedValue([{ id: 'gpt-5', backend: 'openai', type: 'text' }]);
  getLlmByModel.mockReturnValue({ currentModel: '', complete });
  replyWith(PLAN);
});

afterEach(() => vi.useRealTimers());

describe('the planning claim', () => {
  // The finding this closes: the empty-graph check is a read-then-write with a
  // minutes-long LLM call in the gap, so unlocked, two concurrent POSTs both
  // pass it and both write a full plan into one graph - which the empty-graph
  // guard then refuses to re-plan, with no node-delete surface to recover.
  it('refuses without calling the model when another plan holds the claim', async () => {
    claimForPlanning.mockResolvedValue(null);

    await expect(run()).rejects.toThrow('A plan is already being generated');

    expect(complete).not.toHaveBeenCalled();
    expect(addNode).not.toHaveBeenCalled();
    // Nothing was claimed here, so nothing may be released - releasing would
    // hand the graph to a third request while the real holder is still working.
    expect(releasePlanningClaim).not.toHaveBeenCalled();
  });

  it('claims before it reads the graph, so the read cannot go stale', async () => {
    const order: string[] = [];
    claimForPlanning.mockImplementation(async () => {
      order.push('claim');
      return graph();
    });
    getNodes.mockImplementation(async () => {
      order.push('read');
      return [];
    });

    await run();

    expect(order).toEqual(['claim', 'read']);
  });

  it('releases the claim after a successful plan', async () => {
    await run();
    expect(releasePlanningClaim).toHaveBeenCalledWith('g1');
  });

  // A failed plan has to be retryable at once, not after the stale window.
  it('releases the claim when the plan fails', async () => {
    getNodes.mockResolvedValue([{ id: 'existing' }]);

    await expect(run()).rejects.toThrow();

    expect(releasePlanningClaim).toHaveBeenCalledWith('g1');
  });
});

describe('the guards', () => {
  it('refuses a graph that already has nodes', async () => {
    getNodes.mockResolvedValue([{ id: 'existing' }]);
    await expect(run()).rejects.toThrow('already has nodes');
  });

  it('refuses a model that is not available', async () => {
    getAvailableModels.mockResolvedValue([{ id: 'some-other-model' }]);
    await expect(run()).rejects.toThrow('is not available');
  });

  it('reports an unusable reply as a bad result the caller can retry', async () => {
    replyWith('I would love to help but here is prose instead.');
    await expect(run()).rejects.toMatchObject({ statusCode: 400 });
  });
});

// A model that rambled or stalled is a bad result, not a server fault. Before
// this both surfaced as 500s, so a weak model read as our bug and the tester
// step that expects a clear retry message got an internal error instead.
describe('a misbehaving model is a 400, not a 500', () => {
  it('treats a reply past the size cap as a bad result', async () => {
    complete.mockImplementation(async (_m: string, _msgs: unknown, _o: unknown, cb: CompleteCallback) => {
      // Two chunks: the cap trips on the second, mid-stream.
      await cb(['x'.repeat(40_000)], USAGE);
      await cb(['x'.repeat(40_000)], USAGE);
    });

    await expect(run()).rejects.toMatchObject({ statusCode: 400 });
  });

  it('treats a stalled completion as a bad result', async () => {
    vi.useFakeTimers();
    complete.mockImplementation(() => new Promise(() => {}));

    const promise = run();
    // Assert the rejection before advancing, or the rejection races the timers.
    const assertion = expect(promise).rejects.toMatchObject({ statusCode: 400 });
    await vi.advanceTimersByTimeAsync(120_001);
    await assertion;
  });

  it('still reports a write failure as our fault', async () => {
    addNode.mockRejectedValue(new Error('mongo is down'));
    await expect(run()).rejects.toMatchObject({ statusCode: 500 });
  });
});

// The route's own comment called this "one billable LLM completion" while
// nothing metered it, so the spend was invisible.
describe('metering', () => {
  it('records the completion against the graph', async () => {
    await run();

    expect(recordSessionOperationalUsage).toHaveBeenCalledTimes(1);
    expect(recordSessionOperationalUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        requestId: 'g1',
        sessionId: 's1',
        modelId: 'gpt-5',
        completionInfo: USAGE,
      })
    );
  });

  // Tokens spent on a reply we then reject are still tokens spent.
  it('records the spend even when the plan is unusable', async () => {
    replyWith('not a plan');
    await expect(run()).rejects.toThrow();
    expect(recordSessionOperationalUsage).toHaveBeenCalledTimes(1);
  });

  it('records the spend even when the model overran', async () => {
    complete.mockImplementation(async (_m: string, _msgs: unknown, _o: unknown, cb: CompleteCallback) => {
      await cb(['x'.repeat(70_000)], USAGE);
    });

    await expect(run()).rejects.toThrow();

    expect(recordSessionOperationalUsage).toHaveBeenCalledTimes(1);
  });

  it('meters once, not twice, on the failure path', async () => {
    replyWith('not a plan');
    await expect(run()).rejects.toThrow();
    expect(recordSessionOperationalUsage).toHaveBeenCalledTimes(1);
  });

  // A graph created outside a notebook has no session; that must not stop the
  // spend being attributed to the user.
  it('meters a graph with no session', async () => {
    await run({ sessionId: undefined });

    expect(recordSessionOperationalUsage).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'g1', sessionId: undefined })
    );
  });
});

describe('the write', () => {
  it('creates a spine per phase with its tasks beneath it', async () => {
    const result = await run();

    expect(result).toEqual({ created: 4 });
    const kinds = addNode.mock.calls.map(([arg]) => arg.kind);
    expect(kinds).toEqual(['spine', 'task', 'spine', 'task']);
  });

  it('resolves parent and dependency indices to the ids just created', async () => {
    await run();

    const [, firstTask, , secondTask] = addNode.mock.calls.map(([arg]) => arg);
    expect(firstTask).toMatchObject({ parentId: 'n1', dependsOn: [] });
    // Phase two's task waits for the WHOLE of phase one - task n2, not spine n1.
    expect(secondTask).toMatchObject({ parentId: 'n3', dependsOn: ['n2'] });
  });

  it('registers the spine roots only after every node has landed', async () => {
    await run();

    expect(addRootNode.mock.calls.map(([, id]) => id)).toEqual(['n1', 'n3']);
  });

  // All-or-nothing. A half-written plan is worse than none: the empty-graph
  // guard would refuse to re-plan it and there is no node-delete surface, so the
  // quest would be stuck with a partial plan and no way back.
  it('rolls back the nodes it wrote when a later write fails', async () => {
    let calls = 0;
    addNode.mockImplementation(async () => {
      calls += 1;
      if (calls === 3) throw new Error('mongo is down');
      return { id: `n${calls}` };
    });

    await expect(run()).rejects.toThrow('Could not write the plan');

    expect(deleteNode.mock.calls.map(([id]) => id)).toEqual(['n1', 'n2']);
    // The graph keeps no reference to a plan that no longer exists.
    expect(addRootNode).not.toHaveBeenCalled();
  });

  it('survives a delete failing during rollback', async () => {
    addNode.mockImplementationOnce(async () => ({ id: 'n1' })).mockRejectedValueOnce(new Error('mongo is down'));
    deleteNode.mockRejectedValue(new Error('delete failed too'));

    await expect(run()).rejects.toThrow('Could not write the plan');
  });
});
