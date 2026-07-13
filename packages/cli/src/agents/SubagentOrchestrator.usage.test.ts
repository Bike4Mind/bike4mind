/**
 * Tests for SubagentOrchestrator's onSubagentUsage rollup callback.
 *
 * Mocks ReActAgent and generateCliTools so delegateToAgent() runs through its
 * real control flow (agent def lookup, tool assembly, retry, hooks) without
 * hitting a real LLM. Kept separate from SubagentOrchestrator.test.ts because
 * that suite exercises the real ReActAgent; the module mock here is file-scoped.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import { SubagentOrchestrator, type OrchestratorDependencies } from './SubagentOrchestrator.js';
import { HookBlockedError } from './types.js';
import type { AgentDefinition } from './types.js';
import type { AgentStore } from './AgentStore.js';

const mockRun = vi.fn();

vi.mock('@bike4mind/agents', () => ({
  // `new ReActAgent(...)` requires a constructor function, not an arrow function.
  ReActAgent: vi.fn().mockImplementation(function MockReActAgent() {
    return { run: mockRun };
  }),
}));

vi.mock('../utils/toolsAdapter.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/toolsAdapter.js')>();
  return {
    ...actual,
    generateCliTools: vi.fn().mockResolvedValue({
      tools: [],
      agentContext: { currentAgent: null, observationQueue: [] },
    }),
  };
});

const silentLogger: Logger = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeAgentDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'test-agent',
    description: 'Test agent',
    model: 'claude-3-5-haiku-20241022',
    systemPrompt: 'You are a test agent. $TASK',
    allowedTools: [],
    deniedTools: [],
    maxIterations: { quick: 1, medium: 3, very_thorough: 5 },
    defaultThoroughness: 'medium',
    source: 'builtin',
    filePath: '<test>',
    modelResolved: true,
    retry: { maxRetries: 0, initialDelayMs: 0 },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<OrchestratorDependencies> = {}): OrchestratorDependencies {
  const agentStore = {
    getAgent: vi.fn().mockReturnValue(makeAgentDef()),
    getAgentNames: vi.fn().mockReturnValue(['test-agent']),
  } as unknown as AgentStore;

  return {
    userId: 'user-1',
    llm: {} as OrchestratorDependencies['llm'],
    logger: silentLogger,
    permissionManager: {} as OrchestratorDependencies['permissionManager'],
    showPermissionPrompt: vi.fn(),
    configStore: { get: vi.fn().mockResolvedValue({}) },
    apiClient: {} as OrchestratorDependencies['apiClient'],
    agentStore,
    ...overrides,
  };
}

describe('SubagentOrchestrator onSubagentUsage rollup', () => {
  beforeEach(() => {
    mockRun.mockReset();
  });

  it('fires onSubagentUsage with the run totals on normal completion', async () => {
    mockRun.mockResolvedValue({
      finalAnswer: 'Done',
      steps: [],
      completionInfo: {
        totalTokens: 500,
        totalInputTokens: 300,
        totalOutputTokens: 200,
        totalCredits: 7,
        iterations: 2,
        toolCalls: 0,
        reachedMaxIterations: false,
      },
    });

    const onSubagentUsage = vi.fn();
    const orchestrator = new SubagentOrchestrator(makeDeps({ onSubagentUsage }));

    await orchestrator.delegateToAgent({
      task: 'do something',
      agentName: 'test-agent',
      parentSessionId: 'session-1',
    });

    expect(onSubagentUsage).toHaveBeenCalledTimes(1);
    expect(onSubagentUsage).toHaveBeenCalledWith({
      agentName: 'test-agent',
      totalTokens: 500,
      totalCredits: 7,
    });
  });

  it('fires onSubagentUsage with zero totals when a hook blocks the agent', async () => {
    mockRun.mockRejectedValue(new HookBlockedError('some_tool', 'not allowed'));

    const onSubagentUsage = vi.fn();
    const orchestrator = new SubagentOrchestrator(makeDeps({ onSubagentUsage }));

    const result = await orchestrator.delegateToAgent({
      task: 'do something blocked',
      agentName: 'test-agent',
      parentSessionId: 'session-1',
    });

    expect(result.summary).toContain('Agent blocked');
    expect(onSubagentUsage).toHaveBeenCalledTimes(1);
    expect(onSubagentUsage).toHaveBeenCalledWith({
      agentName: 'test-agent',
      totalTokens: 0,
      totalCredits: 0,
    });
  });

  it('does not throw when onSubagentUsage is not provided', async () => {
    mockRun.mockResolvedValue({
      finalAnswer: 'Done',
      steps: [],
      completionInfo: {
        totalTokens: 10,
        totalInputTokens: 5,
        totalOutputTokens: 5,
        iterations: 1,
        toolCalls: 0,
        reachedMaxIterations: false,
      },
    });

    const orchestrator = new SubagentOrchestrator(makeDeps());

    await expect(
      orchestrator.delegateToAgent({
        task: 'do something',
        agentName: 'test-agent',
        parentSessionId: 'session-1',
      })
    ).resolves.toBeDefined();
  });

  it('accumulates totalCredits as undefined without throwing when the source is empty', async () => {
    mockRun.mockResolvedValue({
      finalAnswer: 'Done',
      steps: [],
      completionInfo: {
        totalTokens: 25,
        totalInputTokens: 10,
        totalOutputTokens: 15,
        iterations: 1,
        toolCalls: 0,
        reachedMaxIterations: false,
        // totalCredits intentionally omitted, mirroring the completion callback gap
      },
    });

    const onSubagentUsage = vi.fn();
    const orchestrator = new SubagentOrchestrator(makeDeps({ onSubagentUsage }));

    await orchestrator.delegateToAgent({
      task: 'do something',
      agentName: 'test-agent',
      parentSessionId: 'session-1',
    });

    expect(onSubagentUsage).toHaveBeenCalledWith({
      agentName: 'test-agent',
      totalTokens: 25,
      totalCredits: undefined,
    });
  });
});
