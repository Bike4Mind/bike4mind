import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectDagChildArtifactBlocks } from '@server/queueHandlers/agentExecutor.dagArtifacts';
import {
  MAX_AGENT_ARTIFACTS_PER_RUN,
  buildAgentArtifactPayloads,
  persistAgentArtifacts,
  type PersistAgentArtifactsDeps,
} from './persistAgentArtifacts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

const QUEST_ID = 'quest-1';
const QUEST_CREATED_AT_MS = 1700000000000;
const SESSION_ID = 'session-1';
const USER_ID = 'user-1';
const EXECUTION_ID = 'exec-1';

function reactArtifact(identifier: string, title = 'Foo') {
  return `<artifact identifier="${identifier}" type="application/vnd.ant.react" title="${title}">
export default function Foo() { return <div>hi</div>; }
</artifact>`;
}

function stubDeps(overrides: Partial<PersistAgentArtifactsDeps> = {}): PersistAgentArtifactsDeps {
  return {
    isArtifactsEnabled: vi.fn().mockResolvedValue(true),
    artifactExists: vi.fn().mockResolvedValue(false),
    createArtifact: vi.fn().mockResolvedValue(undefined),
    countQuestArtifacts: vi.fn().mockResolvedValue(0),
    clearPartialArtifact: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Deps backed by a fake store that reproduces the real write ordering:
 * artifact_contents (unique on {artifactId, version}) is written BEFORE the
 * artifacts row, and there is no transaction. `failAfterContentWrite` simulates
 * the crash that leaves an orphan content row behind.
 */
function storeBackedDeps(options: { failAfterContentWrite?: boolean } = {}) {
  const contents = new Set<string>();
  const artifacts = new Map<string, string>(); // artifactId -> questId
  let failNext = options.failAfterContentWrite ?? false;

  const deps: PersistAgentArtifactsDeps = {
    isArtifactsEnabled: vi.fn().mockResolvedValue(true),
    artifactExists: vi.fn(async (id: string) => artifacts.has(id)),
    countQuestArtifacts: vi.fn(async (questId: string) => [...artifacts.values()].filter(q => q === questId).length),
    clearPartialArtifact: vi.fn(async (id: string) => {
      contents.delete(id);
    }),
    createArtifact: vi.fn(async (_userId: string, payload: { id: string; sourceQuestId: string }) => {
      if (contents.has(payload.id)) {
        throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
      }
      contents.add(payload.id);
      if (failNext) {
        failNext = false;
        throw new Error('lambda died after the content write');
      }
      artifacts.set(payload.id, payload.sourceQuestId);
    }),
  };

  return { deps, contents, artifacts };
}

function persist(replyText: string, deps: PersistAgentArtifactsDeps) {
  return persistAgentArtifacts({
    replyText,
    questId: QUEST_ID,
    questCreatedAtMs: QUEST_CREATED_AT_MS,
    sessionId: SESSION_ID,
    userId: USER_ID,
    executionId: EXECUTION_ID,
    logger,
    deps,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('buildAgentArtifactPayloads', () => {
  const build = (replyText: string) =>
    buildAgentArtifactPayloads({
      replyText,
      questId: QUEST_ID,
      questCreatedAtMs: QUEST_CREATED_AT_MS,
      sessionId: SESSION_ID,
    });

  it('mints the client-compatible id for an explicit artifact tag', () => {
    const payloads = build(`Here you go.\n\n${reactArtifact('foo')}`);

    expect(payloads).toHaveLength(1);
    expect(payloads[0].id).toBe(`artifact_react_foo_${QUEST_CREATED_AT_MS}_0`);
    expect(payloads[0].type).toBe('react');
    expect(payloads[0].title).toBe('Foo');
  });

  it('is deterministic across calls (no clock in the id)', () => {
    const reply = `${reactArtifact('foo')}\n\n${reactArtifact('bar', 'Bar')}`;

    const first = build(reply).map(p => p.id);
    const second = build(reply).map(p => p.id);

    expect(first).toEqual(second);
  });

  it('returns nothing for a reply with no artifact and no promotable fence', () => {
    expect(build('Just prose, nothing to persist.')).toEqual([]);
  });

  // parseArtifacts returns its artifacts in reverse document order (it sorts by
  // descending startIndex in place). Pinned because `_{index}` has to stay stable
  // across re-parses of the same reply for the idempotency pre-check to hit.
  it('indexes multiple artifacts in parse order', () => {
    const payloads = build(`${reactArtifact('foo')}\n\n${reactArtifact('bar', 'Bar')}`);

    expect(payloads.map(p => p.id)).toEqual([
      `artifact_react_bar_${QUEST_CREATED_AT_MS}_0`,
      `artifact_react_foo_${QUEST_CREATED_AT_MS}_1`,
    ]);
  });

  it('drops an empty-bodied artifact without shifting the index of the others', () => {
    const empty = '<artifact identifier="blank" type="application/vnd.ant.code" title="Blank">   </artifact>';
    // `empty` is last in the reply, so it is index 0 after the parser's reverse sort.
    const payloads = build(`${reactArtifact('foo')}\n\n${empty}`);

    expect(payloads).toHaveLength(1);
    expect(payloads[0].id).toBe(`artifact_react_foo_${QUEST_CREATED_AT_MS}_1`);
  });

  it('links the row back to the quest and session', () => {
    const [payload] = build(reactArtifact('foo'));

    expect(payload.sourceQuestId).toBe(QUEST_ID);
    expect(payload.metadata.questId).toBe(QUEST_ID);
    expect(payload.metadata.originalIdentifier).toBe('foo');
    expect(payload.sessionId).toBe(SESSION_ID);
  });

  it('promotes a fenced tsx block (the fallback path runs)', () => {
    const payloads = build('```tsx\nexport default function Widget() { return <div />; }\n```');

    expect(payloads).toHaveLength(1);
    expect(payloads[0].type).toBe('react');
  });
});

describe('persistAgentArtifacts', () => {
  it('creates one row per artifact for the run owner', async () => {
    const deps = stubDeps();

    await persist(reactArtifact('foo'), deps);

    expect(deps.createArtifact).toHaveBeenCalledTimes(1);
    const [userId, payload] = vi.mocked(deps.createArtifact).mock.calls[0];
    expect(userId).toBe(USER_ID);
    expect(payload.sessionId).toBe(SESSION_ID);
    expect(payload.sourceQuestId).toBe(QUEST_ID);
  });

  it('skips the settings read entirely when the reply has no artifacts', async () => {
    const deps = stubDeps();

    await persist('Nothing to see here.', deps);

    expect(deps.isArtifactsEnabled).not.toHaveBeenCalled();
    expect(deps.createArtifact).not.toHaveBeenCalled();
  });

  it('persists nothing when EnableArtifacts is off', async () => {
    const deps = stubDeps({ isArtifactsEnabled: vi.fn().mockResolvedValue(false) });

    await persist(reactArtifact('foo'), deps);

    expect(deps.createArtifact).not.toHaveBeenCalled();
  });

  it('skips an artifact that already exists', async () => {
    const deps = stubDeps({ artifactExists: vi.fn().mockResolvedValue(true) });

    await persist(reactArtifact('foo'), deps);

    expect(deps.createArtifact).not.toHaveBeenCalled();
  });

  it('writes exactly one row when the same terminal write runs twice', async () => {
    const persisted = new Set<string>();
    const deps = stubDeps({
      artifactExists: vi.fn(async (id: string) => persisted.has(id)),
      createArtifact: vi.fn(async (_userId: string, payload: { id: string }) => {
        persisted.add(payload.id);
      }),
    });

    await persist(reactArtifact('foo'), deps);
    await persist(reactArtifact('foo'), deps);

    expect(deps.createArtifact).toHaveBeenCalledTimes(1);
  });

  it('treats a duplicate key as success when the artifacts row really is there', async () => {
    const deps = stubDeps({
      // Pre-check misses (a concurrent writer committed between check and write),
      // then the re-check inside the duplicate branch finds the row.
      artifactExists: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      createArtifact: vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 })),
    });

    await expect(persist(reactArtifact('foo'), deps)).resolves.toBeUndefined();
    expect(deps.clearPartialArtifact).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  // The blocker: `artifactService.create` writes contents -> versions -> artifacts
  // with no transaction. A crash after the content write used to make every future
  // attempt throw E11000, which was swallowed as a clean dedup skip - so the
  // artifacts row was never written again, on this run or any other.
  it('recovers an artifact orphaned by a crash partway through create', async () => {
    const first = storeBackedDeps({ failAfterContentWrite: true });

    await persist(reactArtifact('foo'), first.deps);

    // Crash left a content row and no artifact - exactly the wedged state.
    expect(first.contents.size).toBe(1);
    expect(first.artifacts.size).toBe(0);

    // The retry must not silently skip. It clears the orphan and completes.
    await persist(reactArtifact('foo'), first.deps);

    expect(first.deps.clearPartialArtifact).toHaveBeenCalledTimes(1);
    expect(first.artifacts.size).toBe(1);
  });

  it('reports rather than hides an orphan it cannot clear', async () => {
    const deps = stubDeps({
      createArtifact: vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 })),
      clearPartialArtifact: vi.fn().mockRejectedValue(new Error('delete denied')),
    });

    await expect(persist(reactArtifact('foo'), deps)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('manual cleanup'), expect.anything());
  });

  // The second blocker: the executor's natural completion and the gate-stop
  // handler pass DIFFERENT reply text for the same run, so their parsed
  // identifiers - and therefore every artifact id - differ. Only the questId is
  // stable across both, which is why the gate keys off it.
  it('does not double-write when the two terminal paths send different reply text', async () => {
    const { deps, artifacts } = storeBackedDeps();

    await persist(`Here is the component.\n\n${reactArtifact('foo')}`, deps);
    await persist(`Agent stopped by user.\n\n${reactArtifact('foo-v2')}`, deps);

    expect(artifacts.size).toBe(1);
    expect(deps.createArtifact).toHaveBeenCalledTimes(1);
  });

  // A boolean "this quest has artifacts" gate would lock a partially-persisted
  // quest as finished forever: the first write lands row 1, loses row 2 to a
  // transient error, and every later write short-circuits. Counting instead
  // lets the second write finish the job.
  it('completes a quest whose first write only landed some of its rows', async () => {
    const persisted = new Set<string>();
    let failOnce = true;
    const deps = stubDeps({
      artifactExists: vi.fn(async (id: string) => persisted.has(id)),
      countQuestArtifacts: vi.fn(async () => persisted.size),
      createArtifact: vi.fn(async (_userId: string, payload: { id: string }) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('transient mongo blip');
        }
        persisted.add(payload.id);
      }),
    });

    const reply = `${reactArtifact('foo')}\n\n${reactArtifact('bar', 'Bar')}`;

    await persist(reply, deps);
    expect(persisted.size).toBe(1); // one landed, one lost

    await persist(reply, deps);
    expect(persisted.size).toBe(2); // the retry completed it rather than skipping
  });

  it('short-circuits only once the quest is fully persisted', async () => {
    const deps = stubDeps({ countQuestArtifacts: vi.fn().mockResolvedValue(1) });

    await persist(reactArtifact('foo'), deps);

    expect(deps.createArtifact).not.toHaveBeenCalled();
  });

  // A driver error that crossed a serialization boundary arrives as a plain
  // object with only `message`. Missing it would send a genuine duplicate down
  // the generic failure path and leave the orphan unrepaired.
  it('recognises a duplicate-key error that is a plain object, not an Error', async () => {
    const deps = stubDeps({
      createArtifact: vi
        .fn()
        .mockRejectedValue({ message: 'E11000 duplicate key error collection: artifact_contents' }),
    });

    await persist(reactArtifact('foo'), deps);

    expect(deps.clearPartialArtifact).toHaveBeenCalledTimes(1);
  });

  it('still writes for a different quest', async () => {
    const { deps, artifacts } = storeBackedDeps();

    await persist(reactArtifact('foo'), deps);
    await persistAgentArtifacts({
      replyText: reactArtifact('bar'),
      questId: 'quest-2',
      questCreatedAtMs: QUEST_CREATED_AT_MS,
      sessionId: SESSION_ID,
      userId: USER_ID,
      executionId: EXECUTION_ID,
      logger,
      deps,
    });

    expect(artifacts.size).toBe(2);
  });

  it('swallows a generic create failure and logs it', async () => {
    const deps = stubDeps({ createArtifact: vi.fn().mockRejectedValue(new Error('boom')) });

    await expect(persist(reactArtifact('foo'), deps)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('caps the rows written per run and logs the drop', async () => {
    const deps = stubDeps();
    const reply = Array.from({ length: 30 }, (_, i) => reactArtifact(`foo-${i}`, `Foo ${i}`)).join('\n\n');

    await persist(reply, deps);

    expect(deps.createArtifact).toHaveBeenCalledTimes(MAX_AGENT_ARTIFACTS_PER_RUN);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('artifact cap'), expect.anything());
  });

  it('never throws, even when the gate read itself rejects', async () => {
    const deps = stubDeps({ isArtifactsEnabled: vi.fn().mockRejectedValue(new Error('settings down')) });

    await expect(persist(reactArtifact('foo'), deps)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});

/**
 * The parent's own final answer can drop the `<artifact>` blocks its DAG children
 * produced; agentExecutor appends them back onto `replyText` before the terminal
 * Quest write. These cases compose the reply exactly the way it does, so they fail
 * if persistence ever reads the pre-bubble answer instead.
 */
describe('persistAgentArtifacts with DAG-bubbled child artifacts', () => {
  const parentAnswer = 'Summary of the work. No artifact here.';
  const childArtifact =
    '<artifact identifier="child-chart" type="application/vnd.ant.mermaid" title="Child Chart">graph TD; A-->B;</artifact>';

  const bubbleUp = (childAnswers: string[]) => {
    const extraBlocks = collectDagChildArtifactBlocks({ parentAnswer, childAnswers });
    return extraBlocks.length ? `${parentAnswer}\n\n${extraBlocks.join('\n\n')}` : parentAnswer;
  };

  it('persists an artifact only a child produced', async () => {
    const deps = stubDeps();

    await persist(bubbleUp([childArtifact]), deps);

    expect(deps.createArtifact).toHaveBeenCalledTimes(1);
    const [, payload] = vi.mocked(deps.createArtifact).mock.calls[0];
    expect(payload.metadata.originalIdentifier).toBe('child-chart');
    expect(payload.id).toContain('artifact_mermaid_child-chart_');
  });

  it('persists nothing from the parent answer alone', async () => {
    const deps = stubDeps();

    await persist(parentAnswer, deps);

    expect(deps.createArtifact).not.toHaveBeenCalled();
  });

  it('persists a child artifact the parent also reproduced exactly once', async () => {
    const deps = stubDeps();
    const extraBlocks = collectDagChildArtifactBlocks({
      parentAnswer: `${parentAnswer}\n\n${childArtifact}`,
      childAnswers: [childArtifact],
    });

    await persist(`${parentAnswer}\n\n${childArtifact}${extraBlocks.map(b => `\n\n${b}`).join('')}`, deps);

    expect(deps.createArtifact).toHaveBeenCalledTimes(1);
  });
});
