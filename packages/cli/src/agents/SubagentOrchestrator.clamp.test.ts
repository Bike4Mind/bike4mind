import { describe, it, expect, vi, beforeEach } from 'vitest';

// generateCliTools is the point where the resolved model and clamped interaction
// mode land, so spy on it and short-circuit real tool generation / agent execution.
// vi.hoisted lets the (hoisted) mock factory reference the spy safely.
const { generateCliTools } = vi.hoisted(() => ({
  generateCliTools: vi.fn(async () => ({
    tools: [],
    agentContext: { currentAgent: null, observationQueue: [] },
  })),
}));

vi.mock('../utils/toolsAdapter.js', () => ({
  generateCliTools,
  wrapToolWithHooks: (tool: unknown) => tool,
}));

vi.mock('@bike4mind/agents', () => ({
  ReActAgent: class {
    async run() {
      return {
        finalAnswer: 'done',
        steps: [],
        completionInfo: {
          iterations: 1,
          toolCalls: 0,
          totalTokens: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          reachedMaxIterations: false,
        },
      };
    }
  },
}));

import { SubagentOrchestrator, type OrchestratorDependencies } from './SubagentOrchestrator.js';
import { MAX_SUBAGENT_DEPTH } from './types.js';
import { useCliStore } from '../store/index.js';
import type { InteractionMode } from '../bootstrap/types.js';

// Positional indices of the args we assert on in the generateCliTools call.
const MODEL_ARG = 2;
const INTERACTION_MODE_OVERRIDE_ARG = 13;

const agentDef = {
  name: 'explore',
  description: 'test agent',
  source: 'builtin',
  filePath: '<test>',
  model: 'agent-placeholder',
  modelResolved: false,
  systemPrompt: 'You are $TASK',
  maxIterations: { quick: 1, medium: 3, very_thorough: 8 },
  defaultThoroughness: 'medium',
  retry: { maxRetries: 0, initialDelayMs: 0 },
};

function createOrchestrator(): SubagentOrchestrator {
  const deps = {
    userId: 'u1',
    llm: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    permissionManager: {},
    showPermissionPrompt: async () => ({ action: 'allow' }),
    configStore: { get: async () => ({ defaultModel: 'session-model' }) },
    apiClient: {},
    agentStore: { getAgent: () => agentDef, getAgentNames: () => [] },
  } as unknown as OrchestratorDependencies;
  return new SubagentOrchestrator(deps);
}

function lastCall(): unknown[] {
  const { calls } = generateCliTools.mock;
  return (calls[calls.length - 1] ?? []) as unknown[];
}

function lastOverride(): InteractionMode | undefined {
  return lastCall()[INTERACTION_MODE_OVERRIDE_ARG] as InteractionMode | undefined;
}

async function spawn(orchestrator: SubagentOrchestrator, overrides: Record<string, unknown>) {
  return orchestrator.delegateToAgent({
    task: 't',
    agentName: 'explore',
    parentSessionId: 's1',
    ...overrides,
  });
}

describe('SubagentOrchestrator interaction-mode clamp (integration)', () => {
  beforeEach(() => {
    generateCliTools.mockClear();
    useCliStore.setState({ interactionMode: 'normal' });
  });

  it('caps a child request more permissive than the parent', async () => {
    const orchestrator = createOrchestrator();
    await spawn(orchestrator, { parentInteractionMode: 'normal', interactionMode: 'auto-accept' });
    expect(lastOverride()).toBe('normal');
  });

  it('honors a child request at or below the parent ceiling', async () => {
    const orchestrator = createOrchestrator();
    await spawn(orchestrator, { parentInteractionMode: 'auto-accept', interactionMode: 'normal' });
    expect(lastOverride()).toBe('normal');
  });

  it('inherits the parent ceiling when the child requests nothing', async () => {
    const orchestrator = createOrchestrator();
    await spawn(orchestrator, { parentInteractionMode: 'plan' });
    expect(lastOverride()).toBe('plan');
  });

  it('falls back to the live store mode when no parent ceiling is given', async () => {
    useCliStore.setState({ interactionMode: 'auto-accept' });
    const orchestrator = createOrchestrator();
    await spawn(orchestrator, {});
    expect(lastOverride()).toBe('auto-accept');
  });
});

describe('SubagentOrchestrator model resolution (integration)', () => {
  beforeEach(() => {
    generateCliTools.mockClear();
    useCliStore.setState({ interactionMode: 'normal' });
  });

  it('inherits the parent model for an unresolved agent', async () => {
    const orchestrator = createOrchestrator();
    await spawn(orchestrator, { parentModel: 'parent-model' });
    expect(lastCall()[MODEL_ARG]).toBe('parent-model');
  });

  it('lets an explicit model request win over the inherited model', async () => {
    const orchestrator = createOrchestrator();
    await spawn(orchestrator, { model: 'explicit-model', parentModel: 'parent-model' });
    expect(lastCall()[MODEL_ARG]).toBe('explicit-model');
  });
});

describe('SubagentOrchestrator depth cap (integration)', () => {
  beforeEach(() => {
    generateCliTools.mockClear();
    useCliStore.setState({ interactionMode: 'normal' });
  });

  it('rejects at the cap before generating any tools', async () => {
    const orchestrator = createOrchestrator();
    await expect(spawn(orchestrator, { depth: MAX_SUBAGENT_DEPTH })).rejects.toThrow(/reached the limit/);
    expect(generateCliTools).not.toHaveBeenCalled();
  });

  it('spawns normally just below the cap', async () => {
    const orchestrator = createOrchestrator();
    await spawn(orchestrator, { depth: MAX_SUBAGENT_DEPTH - 1 });
    expect(generateCliTools).toHaveBeenCalledTimes(1);
  });
});
