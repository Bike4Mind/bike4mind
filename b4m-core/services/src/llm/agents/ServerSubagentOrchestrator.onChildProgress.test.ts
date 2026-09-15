import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerAgentDefinition } from '@bike4mind/agents';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';

/**
 * Coverage for the in-process subagent's `onChildProgress` emission path.
 *
 * Lives in its own file because we have to mock `ReActAgent` to avoid wiring
 * a full LLM backend, and the sibling `ServerSubagentOrchestrator.test.ts`
 * deliberately exercises the un-mocked path where `agent.run()` throws. Mixing
 * the two in one file would break those tests.
 *
 * The `StubReActAgent` stand-in is defined inside `vi.hoisted` so it's in
 * scope when `vi.mock`'s factory runs - vi.mock factories are themselves
 * hoisted to the top of the file and can't reference normal `class`/`const`
 * declarations below them.
 */
const { StubReActAgent } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events');
  class StubReActAgent extends EventEmitter {
    getIteration(): number {
      return 1;
    }
    async run() {
      const step = {
        type: 'action',
        content: '',
        metadata: { toolName: 'web_search', timestamp: 0 },
      };
      this.emit('action', step);
      // Yield so any `onChildProgress(...).catch(...)` chains settle before
      // the run resolves - matches the real agent's microtask ordering closely
      // enough that the test assertion isn't racey.
      await Promise.resolve();
      return {
        finalAnswer: 'done',
        steps: [step],
        agentName: 'researcher',
        completionInfo: {
          iterations: 1,
          totalCredits: 0,
          totalTokens: 0,
          reachedMaxIterations: false,
        },
      };
    }
  }
  return { StubReActAgent };
});

vi.mock('@bike4mind/agents', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/agents')>();
  return {
    ...actual,
    ReActAgent: StubReActAgent,
  };
});

// Importing AFTER the mock so the orchestrator picks up `StubReActAgent`.
import { ServerSubagentOrchestrator, type ServerSubagentTracker } from './ServerSubagentOrchestrator';

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    updateMetadata: vi.fn(),
  } as unknown as Logger;
}

function makeLlm(model = 'claude-sonnet-4-6'): ICompletionBackend {
  return {
    currentModel: model,
    complete: vi.fn(),
    pushToolMessages: vi.fn(),
    getModelInfo: vi.fn().mockResolvedValue([]),
  } as unknown as ICompletionBackend;
}

function makeAgentDef(overrides: Partial<ServerAgentDefinition> = {}): ServerAgentDefinition {
  return {
    name: 'researcher',
    description: 'Test agent',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'You are a researcher. Task: $TASK',
    maxIterations: { quick: 3, medium: 6, very_thorough: 12 },
    defaultThoroughness: 'medium',
    ...overrides,
  };
}

function makeTracker(overrides: Partial<ServerSubagentTracker> = {}): ServerSubagentTracker {
  return {
    onStart: vi.fn().mockResolvedValue('child-progress-id'),
    onComplete: vi.fn().mockResolvedValue(undefined),
    onFailure: vi.fn().mockResolvedValue(undefined),
    onLambdaDispatch: vi.fn().mockResolvedValue(undefined),
    pollChildStatus: vi.fn(),
    abortChild: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ServerSubagentOrchestrator — tracker.onChildProgress (#8775)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('forwards in-process child action steps to tracker.onChildProgress with humanized status', async () => {
    const onChildProgress = vi.fn().mockResolvedValue(undefined);
    const onProgress = vi.fn().mockResolvedValue(undefined);
    const tracker = makeTracker({ onChildProgress });

    const orchestrator = new ServerSubagentOrchestrator({
      userId: 'u1',
      llm: makeLlm(),
      logger: makeLogger(),
      parentTools: [],
      tracker,
      // Wire both channels so we can assert the new one is preferred over the
      // legacy parent `onProgress` when a tracker is available.
      onProgress,
    });

    await orchestrator.delegateToAgent({
      task: 't',
      agentDef: makeAgentDef(),
      thoroughness: 'quick',
    });

    // humanizeToolName('web_search') -> 'webbing search'; emitter appends '...'.
    expect(onChildProgress).toHaveBeenCalledWith({
      childExecutionId: 'child-progress-id',
      status: 'webbing search...',
    });
    // Parent's onProgress must NOT receive the child's action - the whole
    // point is moving this off the parent channel so the parent
    // status banner stops getting clobbered by subagent tool names.
    expect(onProgress).not.toHaveBeenCalledWith('webbing search...');
  });

  it('falls back to parent onProgress when tracker has no onChildProgress hook', async () => {
    const onProgress = vi.fn().mockResolvedValue(undefined);
    // Tracker without `onChildProgress` simulates a future caller (or test
    // double) that opted out of the per-child channel.
    const tracker = makeTracker();
    // Spread-omit pattern to ensure `onChildProgress` is genuinely absent.
    delete (tracker as { onChildProgress?: unknown }).onChildProgress;

    const orchestrator = new ServerSubagentOrchestrator({
      userId: 'u1',
      llm: makeLlm(),
      logger: makeLogger(),
      parentTools: [],
      tracker,
      onProgress,
    });

    await orchestrator.delegateToAgent({
      task: 't',
      agentDef: makeAgentDef(),
      thoroughness: 'quick',
    });

    expect(onProgress).toHaveBeenCalledWith('webbing search...');
  });

  it('logs a warning when onChildProgress rejects, agent keeps running', async () => {
    const logger = makeLogger();
    const onChildProgress = vi.fn().mockRejectedValue(new Error('WS send failed'));
    const tracker = makeTracker({ onChildProgress });

    const orchestrator = new ServerSubagentOrchestrator({
      userId: 'u1',
      llm: makeLlm(),
      logger,
      parentTools: [],
      tracker,
    });

    const result = await orchestrator.delegateToAgent({
      task: 't',
      agentDef: makeAgentDef(),
      thoroughness: 'quick',
    });

    // Result still resolves - a WS-side failure must never block the agent.
    expect(result.finalAnswer).toBe('done');
    // The error landed in the logger, not silently swallowed.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('onChildProgress failed'));
  });
});
