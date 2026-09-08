import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import type { AgentResult } from '../../types';
import type { Charter, DriveVector } from '../schemas';
import { agentResultToActResult, createReActRunAct } from './reactAct';
import type { ActContext } from './types';
import { resolveToolbeltProfile, DEFAULT_TOOLBELT_ROLE } from './toolbelts';

// Hoisted so the vi.mock factories (hoisted above imports) can reference them.
const { mockReplSessionCtor, mockMakeCodeExecuteTool, mockAgentRun, mockSessionDispose } = vi.hoisted(() => ({
  // Captures the options the wake path asks for. Which executor it picks is the
  // security posture of the whole deep-agent runtime, so it has to be observable.
  mockReplSessionCtor: vi.fn(),
  mockMakeCodeExecuteTool: vi.fn(() => ({ toolSchema: { name: 'code_execute' } })),
  mockAgentRun: vi.fn(),
  mockSessionDispose: vi.fn(),
}));

// Spread the real modules rather than replacing them: these files export more
// than the one symbol each (registry helpers, BudgetExceededError, ...) and a
// bare factory would break any of them reached transitively.
vi.mock('../../rlm/ReplSession', async importOriginal => ({
  ...(await importOriginal<typeof import('../../rlm/ReplSession')>()),
  ReplSession: class {
    constructor(opts: unknown) {
      mockReplSessionCtor(opts);
    }
    setTools = vi.fn();
    dispose = mockSessionDispose;
  },
}));
vi.mock('../../rlm/codeExecuteTool', async importOriginal => ({
  ...(await importOriginal<typeof import('../../rlm/codeExecuteTool')>()),
  makeCodeExecuteTool: mockMakeCodeExecuteTool,
}));
vi.mock('../../ReActAgent', async importOriginal => ({
  ...(await importOriginal<typeof import('../../ReActAgent')>()),
  ReActAgent: class {
    on = vi.fn();
    run = mockAgentRun;
  },
}));

function agentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    finalAnswer: 'done',
    steps: [],
    completionInfo: {
      totalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      iterations: 1,
      toolCalls: 0,
      reachedMaxIterations: false,
    },
    ...overrides,
  };
}

describe('agentResultToActResult', () => {
  it('maps action steps to actionsTaken with tool name + input', () => {
    const result = agentResult({
      steps: [
        {
          type: 'action',
          content: 'calling bash_execute',
          metadata: { toolName: 'bash_execute', toolInput: { cmd: 'ls' }, timestamp: 1 },
        },
      ],
    });
    const act = agentResultToActResult(result);
    expect(act.actionsTaken).toEqual([{ tool: 'bash_execute', input: { cmd: 'ls' }, succeeded: true }]);
  });

  it('maps observation steps and appends the final answer as an observation', () => {
    const result = agentResult({
      finalAnswer: 'reproduced the figure',
      steps: [{ type: 'observation', content: 'exit 0', metadata: { timestamp: 1 } }],
    });
    const act = agentResultToActResult(result);
    expect(act.observations).toEqual([
      { kind: 'tool_result', summary: 'exit 0' },
      { kind: 'final_answer', summary: 'reproduced the figure' },
    ]);
  });

  it('carries token spend from completionInfo', () => {
    const act = agentResultToActResult(
      agentResult({ completionInfo: { ...agentResult().completionInfo, totalTokens: 4096 } })
    );
    expect(act.tokensSpent).toBe(4096);
  });

  it('falls back to "unknown" when an action step lacks a tool name', () => {
    const result = agentResult({ steps: [{ type: 'action', content: '?', metadata: { timestamp: 1 } }] });
    expect(agentResultToActResult(result).actionsTaken[0].tool).toBe('unknown');
  });

  it('omits the final-answer observation when there is no final answer', () => {
    const act = agentResultToActResult(agentResult({ finalAnswer: '' }));
    expect(act.observations).toEqual([]);
  });
});

describe('resolveToolbeltProfile', () => {
  it('returns the paper-repro profile for that role', () => {
    const profile = resolveToolbeltProfile('paper-repro');
    expect(profile.role).toBe('paper-repro');
    expect(profile.maxIterations).toBeGreaterThan(0);
    expect(profile.enabledToolNames.length).toBeGreaterThan(0);
  });

  it('falls back to the default profile for an unknown role', () => {
    const profile = resolveToolbeltProfile('astronaut-poet');
    expect(profile.role).toBe(DEFAULT_TOOLBELT_ROLE);
    // Default is a capable general web toolbelt (web-safe tools only).
    expect(profile.enabledToolNames).toContain('web_search');
    expect(profile.enabledToolNames).not.toContain('bash_execute');
  });
});

// --- createReActRunAct: the wake path's sandbox wiring -----------------------
// The `rlm-answer` route has the same pair of tests. Mirrored here because the
// invariant is one identifier wide: flipping 'isolated' to 'in-process-unsafe'
// compiles fine and would put LLM-authored code in the wake runtime's own realm,
// next to the platform credentials this process holds.

const NEUTRAL: DriveVector = {
  curiosity: 0.5,
  progress: 0.5,
  social: 0.5,
  novelty: 0.5,
  caution: 0.5,
  aesthetic: 0.5,
};
const ISO = '2026-06-08T12:00:00.000Z';

function makeCharter(): Charter {
  return {
    identity: {
      agentId: 'agent-1',
      ownerUserId: 'owner-1',
      name: 'Reproducer',
      role: 'paper-repro',
      instantiatedAt: ISO,
      schemaVersion: 1,
    },
    goal: { description: 'Reproduce the target paper', successCriteria: [], deadlineKind: 'none' },
    drives: { ...NEUTRAL },
    subgoals: [],
    semanticMemory: [],
    currentTier: 'engineering-proxy',
    openQuestions: [],
    blockers: [],
    sizeBudgetBytes: 8192,
    version: 1,
    updatedAt: ISO,
  };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function actContext(): ActContext {
  return {
    charter: makeCharter(),
    policy: { actionKind: 'ideate', rationale: 'novelty low' },
    drives: { ...NEUTRAL },
  } as ActContext;
}

describe('createReActRunAct sandbox wiring', () => {
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = makeLogger();
    mockMakeCodeExecuteTool.mockReturnValue({ toolSchema: { name: 'code_execute' } });
    mockAgentRun.mockResolvedValue({
      finalAnswer: 'done',
      steps: [],
      completionInfo: {
        totalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        iterations: 1,
        toolCalls: 0,
        reachedMaxIterations: false,
      },
    });
  });

  function runAct() {
    return createReActRunAct({
      llm: {} as never,
      model: 'global.anthropic.claude-sonnet-4-6',
      logger: logger as unknown as Logger,
      buildTools: async () => [],
    })(actContext());
  }

  it('runs guest code in an isolated-vm isolate, never a shared-realm backend', async () => {
    await runAct();

    expect(mockReplSessionCtor).toHaveBeenCalledTimes(1);
    // The literal 25_000 rather than an import of WAKE_PER_CALL_REPL_TIMEOUT_MS:
    // importing the constant would assert it equals itself and move with any
    // edit. A wake step has to stay under the 55s request cap to be observable
    // at all, so the number is the invariant and belongs written out here.
    expect(mockReplSessionCtor.mock.calls[0][0]).toMatchObject({
      executor: 'isolated',
      perCallTimeoutMs: 25_000,
    });
    expect(mockMakeCodeExecuteTool).toHaveBeenCalledTimes(1);
  });

  it('drops code_execute but still completes the wake when the sandbox cannot be constructed', async () => {
    // A missing native addon is the realistic cause. Dropping the tool costs the
    // agent a capability; running it unsandboxed would cost the platform its
    // secrets - so this must fail closed, not fall back to another backend.
    mockReplSessionCtor.mockImplementationOnce(() => {
      throw new Error('No native build was found for isolated-vm');
    });

    const result = await runAct();

    expect(result.observations).toEqual([{ kind: 'final_answer', summary: 'done' }]);
    expect(mockMakeCodeExecuteTool).not.toHaveBeenCalled();
    expect(mockReplSessionCtor).toHaveBeenCalledTimes(1);
    const starting = logger.info.mock.calls.find(c => String(c[0]).includes('starting'));
    expect(starting?.[1]).toMatchObject({ codeExecute: false, tools: [] });
  });

  // An isolate is an OS-level resource (its own V8 heap, plus host-side
  // Reference handles that the guest isolate's own disposal does not reclaim).
  // The wake runtime is long-lived, so a leak here accumulates per wake rather
  // than being cleaned up by process exit.
  it('disposes the isolate when the wake completes', async () => {
    await runAct();

    expect(mockSessionDispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the isolate even when the agent run throws', async () => {
    mockAgentRun.mockRejectedValueOnce(new Error('llm exploded mid-trajectory'));

    await expect(runAct()).rejects.toThrow('llm exploded mid-trajectory');

    // The failure path is the one that matters: a wake that throws is exactly
    // when nobody is around to clean up after it.
    expect(mockSessionDispose).toHaveBeenCalledTimes(1);
  });

  it('does not attempt disposal when the sandbox was never constructed', async () => {
    mockReplSessionCtor.mockImplementationOnce(() => {
      throw new Error('No native build was found for isolated-vm');
    });

    await runAct();

    expect(mockSessionDispose).not.toHaveBeenCalled();
  });
});
