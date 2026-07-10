import { describe, it, expect, vi } from 'vitest';
import type { ICompletionBackend, CompletionInfo, ICompletionOptions } from '@bike4mind/llm-adapters';
import type { IMessage } from '@bike4mind/common';
import { SubagentOrchestrator, type OrchestratorDependencies, type SpawnAgentOptions } from './SubagentOrchestrator.js';
import { MAX_SUBAGENT_DEPTH } from './types.js';
import { AgentHistoryStore } from './AgentHistoryStore.js';
import { createResumeAgentTool } from './resumeAgentTool.js';

// Stub tool generation so a real run needs no live apiClient/permission wiring.
// The depth-cap tests below never reach this call (they throw at the agent
// lookup first), so the stub only affects the capture test.
vi.mock('../utils/toolsAdapter.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/toolsAdapter.js')>();
  return {
    ...actual,
    generateCliTools: vi.fn(async (...args: unknown[]) => ({ tools: [], agentContext: args[5] })),
  };
});

/**
 * Minimal dependency stub. The depth guard runs before any dependency is
 * touched, so an empty agent store is enough to exercise the boundary: a spawn
 * that clears the guard falls through to the "Unknown agent" lookup error.
 */
function createOrchestrator(): SubagentOrchestrator {
  const deps = {
    agentStore: {
      getAgent: () => undefined,
      getAgentNames: () => [],
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    configStore: { get: async () => ({}) },
  } as unknown as OrchestratorDependencies;
  return new SubagentOrchestrator(deps);
}

describe('SubagentOrchestrator depth cap', () => {
  it('rejects a spawn at MAX_SUBAGENT_DEPTH before touching dependencies', async () => {
    const orchestrator = createOrchestrator();
    await expect(
      orchestrator.delegateToAgent({
        task: 'anything',
        agentName: 'explore',
        parentSessionId: 'session-1',
        depth: MAX_SUBAGENT_DEPTH,
      })
    ).rejects.toThrow(/nesting depth .* reached the limit/);
  });

  it('rejects a spawn above MAX_SUBAGENT_DEPTH', async () => {
    const orchestrator = createOrchestrator();
    await expect(
      orchestrator.delegateToAgent({
        task: 'anything',
        agentName: 'explore',
        parentSessionId: 'session-1',
        depth: MAX_SUBAGENT_DEPTH + 5,
      })
    ).rejects.toThrow(/reached the limit/);
  });

  it('lets a spawn just below the cap through the depth guard', async () => {
    const orchestrator = createOrchestrator();
    // Clears the depth guard, then fails on the (stubbed) unknown-agent lookup -
    // proving the guard did not reject it.
    await expect(
      orchestrator.delegateToAgent({
        task: 'anything',
        agentName: 'explore',
        parentSessionId: 'session-1',
        depth: MAX_SUBAGENT_DEPTH - 1,
      })
    ).rejects.toThrow(/Unknown agent/);
  });

  it('defaults an omitted depth to 1 (a direct child), which is allowed', async () => {
    const orchestrator = createOrchestrator();
    await expect(
      orchestrator.delegateToAgent({
        task: 'anything',
        agentName: 'explore',
        parentSessionId: 'session-1',
      })
    ).rejects.toThrow(/Unknown agent/);
  });
});

/** LLM that returns a final answer on its first call, so a run finishes in one iteration. */
function createOneShotLlm(answer: string): ICompletionBackend {
  return {
    currentModel: 'test-model',
    getModelInfo: async () => [],
    complete: async (
      _model: string,
      _messages: IMessage[],
      _options: Partial<ICompletionOptions>,
      callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
    ) => {
      await callback([answer], { inputTokens: 10, outputTokens: 5, toolsUsed: [] });
    },
    pushToolMessages: vi.fn(),
  };
}

/** Inline agent definition (bypasses AgentStore) for a minimal, no-tools run. */
function inlineAgent(): SpawnAgentOptions['agentDefinition'] {
  return {
    description: 'test agent',
    model: 'test-model',
    modelResolved: true,
    systemPrompt: 'You are a test agent.',
    maxIterations: { quick: 1, medium: 1, very_thorough: 1 },
    defaultThoroughness: 'quick',
    retry: { maxRetries: 0, initialDelayMs: 0 },
  };
}

function createRunnableOrchestrator(historyStore: AgentHistoryStore, llm: ICompletionBackend): SubagentOrchestrator {
  const deps = {
    userId: 'test-user',
    llm,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    permissionManager: {},
    showPermissionPrompt: vi.fn(),
    configStore: { get: async () => ({}) },
    apiClient: {},
    agentStore: { getAgent: () => undefined, getAgentNames: () => [] },
    historyStore,
  } as unknown as OrchestratorDependencies;
  return new SubagentOrchestrator(deps);
}

describe('SubagentOrchestrator history capture', () => {
  it('stores the finished conversation and returns a resume id', async () => {
    const historyStore = new AgentHistoryStore();
    const orchestrator = createRunnableOrchestrator(historyStore, createOneShotLlm('done'));

    const result = await orchestrator.delegateToAgent({
      task: 'do the thing',
      agentName: 'tester',
      parentSessionId: 'session-1',
      agentDefinition: inlineAgent(),
    });

    expect(result.resumeId).toMatch(/^sub-/);
    expect(historyStore.has(result.resumeId)).toBe(true);
    const stored = historyStore.get(result.resumeId);
    expect(stored?.agentName).toBe('tester');
    expect(stored?.parentSessionId).toBe('session-1');
    expect(stored?.checkpoint.messages.length).toBeGreaterThan(0);
  });

  it('stores under a caller-supplied resume id and replays previousMessages', async () => {
    const historyStore = new AgentHistoryStore();
    const orchestrator = createRunnableOrchestrator(historyStore, createOneShotLlm('done'));
    const prior: IMessage[] = [{ role: 'user', content: 'earlier context marker' }];

    const result = await orchestrator.delegateToAgent({
      task: 'continue',
      agentName: 'tester',
      parentSessionId: 'session-1',
      agentDefinition: inlineAgent(),
      resumeId: 'bg-1234',
      previousMessages: prior,
    });

    expect(result.resumeId).toBe('bg-1234');
    const stored = historyStore.get('bg-1234');
    // run() builds [system, ...previousMessages, user], so the prior message is replayed at index 1.
    const replayed = stored?.checkpoint.messages.find(m => m.content === 'earlier context marker');
    expect(replayed).toBeDefined();
  });
});

describe('resume_agent end-to-end through the real orchestrator', () => {
  it('a delegated session, resumed via the tool, replays its prior conversation into the new run', async () => {
    // Records the messages the LLM sees on each call, so we can prove the
    // resumed run received the first run's conversation.
    const seenPerCall: string[][] = [];
    const recordingLlm: ICompletionBackend = {
      currentModel: 'test-model',
      getModelInfo: async () => [],
      complete: async (
        _model: string,
        messages: IMessage[],
        _options: Partial<ICompletionOptions>,
        callback: (text: (string | null | undefined)[], info?: CompletionInfo) => Promise<void>
      ) => {
        seenPerCall.push(messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))));
        await callback(['acknowledged'], { inputTokens: 10, outputTokens: 5, toolsUsed: [] });
      },
      pushToolMessages: vi.fn(),
    };

    const historyStore = new AgentHistoryStore();
    const orchestrator = createRunnableOrchestrator(historyStore, recordingLlm);
    const resumeTool = createResumeAgentTool(orchestrator, historyStore);

    // 1. Delegate an initial task.
    const first = await orchestrator.delegateToAgent({
      task: 'investigate the login bug',
      agentName: 'tester',
      parentSessionId: 'session-1',
      agentDefinition: inlineAgent(),
    });
    expect(historyStore.has(first.resumeId)).toBe(true);

    // 2. Resume it with a follow-up via the tool.
    seenPerCall.length = 0;
    const out = (await resumeTool.toolFn({ job_id: first.resumeId, task: 'now write the fix' })) as string;

    // 3. The resumed run's messages must carry the original task AND the follow-up,
    //    proving prior context was injected (and not double-counting a system prompt).
    expect(seenPerCall.length).toBeGreaterThan(0);
    const resumedMessages = seenPerCall[0];
    expect(resumedMessages.some(c => c.includes('investigate the login bug'))).toBe(true);
    expect(resumedMessages.some(c => c.includes('now write the fix'))).toBe(true);
    // The agent's own prior answer is replayed too, so the resumed run can act on
    // what it previously concluded (final answers are captured as assistant turns).
    expect(resumedMessages.filter(c => c === 'acknowledged').length).toBe(1);
    expect(resumedMessages.filter(c => c.startsWith('You are a test agent.')).length).toBe(1);
    expect(out).toContain('acknowledged');
  });
});
