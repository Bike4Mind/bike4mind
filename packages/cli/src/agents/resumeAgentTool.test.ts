import { describe, it, expect, vi } from 'vitest';
import type { AgentCheckpoint } from '@bike4mind/agents';
import type { IMessage } from '@bike4mind/common';
import { createResumeAgentTool } from './resumeAgentTool.js';
import { AgentHistoryStore } from './AgentHistoryStore.js';
import { ALWAYS_DENIED_FOR_AGENTS } from './types.js';
import type { SubagentOrchestrator, SpawnAgentOptions, AgentExecutionResult } from './SubagentOrchestrator.js';
import type { BackgroundAgentManager } from './BackgroundAgentManager.js';
import type { AgentDefinition } from './types.js';

function definition(): AgentDefinition {
  return {
    name: 'explore',
    description: 'test agent',
    model: 'test-model',
    modelResolved: true,
    systemPrompt: 'You are a test agent.',
    maxIterations: { quick: 1, medium: 1, very_thorough: 1 },
    defaultThoroughness: 'medium',
    source: 'builtin',
    filePath: '<test>',
    retry: { maxRetries: 0, initialDelayMs: 0 },
  };
}

function checkpointWith(messages: IMessage[]): AgentCheckpoint {
  return {
    iteration: 1,
    messages,
    steps: [],
    totalTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCredits: 0,
    toolCallCount: 0,
    confidenceLog: [],
    iterationConfidences: [],
  };
}

function seedHistory(store: AgentHistoryStore, id: string, messages: IMessage[]): void {
  store.set(id, {
    checkpoint: checkpointWith(messages),
    agentName: 'explore',
    agentDefinition: definition(),
    thoroughness: 'medium',
    parentSessionId: 'session-1',
    endTime: Date.now(),
  });
}

function mockOrchestrator(): { orchestrator: SubagentOrchestrator; calls: SpawnAgentOptions[] } {
  const calls: SpawnAgentOptions[] = [];
  const orchestrator = {
    delegateToAgent: vi.fn(async (opts: SpawnAgentOptions): Promise<AgentExecutionResult> => {
      calls.push(opts);
      return {
        agentName: opts.agentName,
        thoroughness: 'medium',
        summary: 'resumed summary',
        parentSessionId: opts.parentSessionId,
        resumeId: opts.resumeId ?? 'generated',
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
      };
    }),
  } as unknown as SubagentOrchestrator;
  return { orchestrator, calls };
}

describe('resume_agent tool', () => {
  it('is denied to sub-agents to prevent resume chaining', () => {
    expect(ALWAYS_DENIED_FOR_AGENTS).toContain('resume_agent');
  });

  it('returns a friendly message when the session is unknown', async () => {
    const store = new AgentHistoryStore();
    const { orchestrator, calls } = mockOrchestrator();
    const tool = createResumeAgentTool(orchestrator, store);

    const out = (await tool.toolFn({ job_id: 'nope', task: 'fix it' })) as string;
    expect(out).toMatch(/No resumable session/);
    expect(calls).toHaveLength(0);
  });

  it('requires job_id and task', async () => {
    const store = new AgentHistoryStore();
    const { orchestrator } = mockOrchestrator();
    const tool = createResumeAgentTool(orchestrator, store);

    await expect(tool.toolFn({ task: 'x' })).rejects.toThrow(/job_id is required/);
    await expect(tool.toolFn({ job_id: 'y' })).rejects.toThrow(/task is required/);
  });

  it('replays prior messages with the leading system message stripped', async () => {
    const store = new AgentHistoryStore();
    seedHistory(store, 'bg-1', [
      { role: 'system', content: 'ORIGINAL SYSTEM PROMPT' },
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'first answer' },
    ]);
    const { orchestrator, calls } = mockOrchestrator();
    const tool = createResumeAgentTool(orchestrator, store);

    const out = (await tool.toolFn({ job_id: 'bg-1', task: 'now fix the bug' })) as string;

    expect(calls).toHaveLength(1);
    const opts = calls[0];
    expect(opts.task).toBe('now fix the bug');
    expect(opts.agentName).toBe('explore');
    expect(opts.parentSessionId).toBe('session-1');
    expect(opts.resumeId).toBe('bg-1');
    // System message dropped; the rest replayed.
    expect(opts.previousMessages).toEqual([
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'first answer' },
    ]);
    expect(out).toContain('resumed summary');
  });

  it('routes to the background manager when run_in_background is set', async () => {
    const store = new AgentHistoryStore();
    seedHistory(store, 'bg-1', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'earlier' },
    ]);
    const { orchestrator, calls } = mockOrchestrator();
    const spawn = vi.fn((_opts: SpawnAgentOptions) => 'bg-new');
    const manager = { spawn } as unknown as BackgroundAgentManager;
    const tool = createResumeAgentTool(orchestrator, store, manager);

    const out = (await tool.toolFn({ job_id: 'bg-1', task: 'continue', run_in_background: true })) as string;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0); // foreground delegate not used
    expect(out).toContain('bg-new');
    const spawnedOpts = spawn.mock.calls[0][0];
    expect(spawnedOpts.previousMessages).toEqual([{ role: 'user', content: 'earlier' }]);
  });
});
