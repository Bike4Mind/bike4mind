import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OPTI_SURFACE } from '@bike4mind/common';
import type { IOptiPlanState } from '@bike4mind/database';

const { order, tag } = vi.hoisted(() => {
  const order: string[] = [];
  const tag =
    (id: string) =>
    (tools: Record<string, unknown>, ...rest: unknown[]): Record<string, unknown> => {
      order.push(id);
      const state = rest.find(r => typeof r === 'object') as { seen?: string[] } | undefined;
      state?.seen?.push(id);
      return { ...tools, [id]: { name: id, implementation: () => ({}) } };
    };
  return { order, tag };
});

vi.mock('./agentExecutorUtils/decomposeGuard', () => ({ guardDecomposeOnce: vi.fn(tag('decompose-once')) }));
vi.mock('./agentExecutorUtils/planCompletionGuard', () => ({ guardPlanCompletion: vi.fn(tag('plan-completion')) }));
vi.mock('./agentExecutorUtils/briefContextInjector', () => ({ injectBriefContext: vi.fn(tag('brief-context')) }));
vi.mock('@bike4mind/server-utils/premium-generated/premiumAgentExtensions.generated', () => ({
  premiumAgentExtensions: [{ toolMapGuards: [{ id: 'fixture-guard', priority: 10, apply: tag('fixture-guard') }] }],
}));

import {
  createExecutorAgentExtensions,
  executorAgentExtensions,
  type ExecutorToolMap,
} from './agentExecutor.agentExtensions';
import { buildOptiOrchestrationProfile } from './agentExecutor.optiProfile';

const logger = { info: vi.fn(), warn: vi.fn() };

describe('executor agent extensions', () => {
  beforeEach(() => {
    order.length = 0;
    vi.clearAllMocks();
  });

  it('registers the built-in profile and guards, in priority order, with no contributions', () => {
    expect(createExecutorAgentExtensions([]).list()).toEqual({
      surfaceProfiles: [{ id: 'synthetic:opti-orchestration', surface: OPTI_SURFACE, source: 'builtin' }],
      toolMapGuards: [
        { id: 'decompose-once', priority: 100, source: 'builtin' },
        { id: 'plan-completion', priority: 200, source: 'builtin' },
        { id: 'brief-context', priority: 300, source: 'builtin' },
      ],
    });
  });

  it('resolves the built-in surface profile exactly as the direct builder does', () => {
    const registry = createExecutorAgentExtensions([]);
    const contributedToolNames = ['tool_a', 'tool_b'];
    const resolved = registry.resolveSurfaceProfile(OPTI_SURFACE, { executionId: 'e', logger, contributedToolNames });
    expect(resolved).toEqual(buildOptiOrchestrationProfile({ premiumToolNames: contributedToolNames }));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(registry.resolveSurfaceProfile('chat', { executionId: 'e', logger, contributedToolNames })).toBeUndefined();
  });

  it('warns once when the surface resolves with no contributed tools', () => {
    createExecutorAgentExtensions([]).resolveSurfaceProfile(OPTI_SURFACE, {
      executionId: 'e',
      logger,
      contributedToolNames: [],
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toEqual({ executionId: 'e' });
  });

  it('wraps decompose, then plan-completion, then brief over one shared run state', () => {
    const runState = { seen: [] as string[] } as unknown as IOptiPlanState & { seen: string[] };
    const out = createExecutorAgentExtensions([]).applyToolMapGuards({} as ExecutorToolMap, {
      executionId: 'e',
      logger,
      runState,
    });
    expect(order).toEqual(['decompose-once', 'plan-completion', 'brief-context']);
    // brief-context is called without the run state, so only the inner two record on it.
    expect(runState.seen).toEqual(['decompose-once', 'plan-completion']);
    expect(Object.keys(out)).toEqual(['decompose-once', 'plan-completion', 'brief-context']);
  });

  it('applies a contributed guard inside the built-ins and drops one that collides', () => {
    const warn = vi.fn();
    const registry = createExecutorAgentExtensions(
      [
        {
          toolMapGuards: [
            { id: 'fixture-guard', priority: 10, apply: tag('fixture-guard') as never },
            { id: 'brief-context', priority: 20, apply: tag('impostor') as never },
          ],
        },
      ],
      { warn }
    );
    expect(warn).toHaveBeenCalledTimes(1);
    registry.applyToolMapGuards({} as ExecutorToolMap, { executionId: 'e', logger, runState: {} as IOptiPlanState });
    expect(order).toEqual(['fixture-guard', 'decompose-once', 'plan-completion', 'brief-context']);
  });

  it.each([
    null,
    false,
    { name: 'fixture', implementation: 'not-callable' },
    { name: 42, implementation: () => ({}) },
    { name: 'fixture', implementation: () => ({}), artifactType: false },
  ])('skips malformed contributed tool definitions (%s)', malformed => {
    const original = { fixture: { name: 'fixture', implementation: vi.fn() } };
    const registry = createExecutorAgentExtensions([
      { toolMapGuards: [{ id: 'invalid-tool', priority: 1, apply: () => ({ fixture: malformed }) as never }] },
    ]);

    const result = registry.applyToolMapGuards(original, {
      executionId: 'e',
      logger,
      runState: {} as IOptiPlanState,
    });

    expect(result.fixture).toBe(original.fixture);
    expect(order).toEqual(['decompose-once', 'plan-completion', 'brief-context']);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('returned no tool map'), {
      id: 'invalid-tool',
    });
  });

  it('accepts a valid contributed tool wrapper', () => {
    const original = { fixture: { name: 'fixture', implementation: vi.fn() } };
    const wrapped = { ...original.fixture, implementation: vi.fn() };
    const registry = createExecutorAgentExtensions([
      { toolMapGuards: [{ id: 'wrapper', priority: 1, apply: tools => ({ ...tools, fixture: wrapped }) }] },
    ]);

    const result = registry.applyToolMapGuards(original, {
      executionId: 'e',
      logger,
      runState: {} as IOptiPlanState,
    });

    expect(result.fixture).toBe(wrapped);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('builds the shared registry from the generated contributions', () => {
    expect(executorAgentExtensions.list().toolMapGuards).toEqual([
      { id: 'fixture-guard', priority: 10, source: 'contribution' },
      { id: 'decompose-once', priority: 100, source: 'builtin' },
      { id: 'plan-completion', priority: 200, source: 'builtin' },
      { id: 'brief-context', priority: 300, source: 'builtin' },
    ]);
  });

  it('is frozen after construction', () => {
    const registry = createExecutorAgentExtensions([]);
    expect(() => registry.registerContribution({ toolMapGuards: [] })).toThrow(/frozen/);
    expect(() => registry.registerToolMapGuard({ id: 'late', priority: 1, apply: t => t }, 'contribution')).toThrow(
      /frozen/
    );
  });
});
