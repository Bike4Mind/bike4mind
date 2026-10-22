import { describe, it, expect, vi } from 'vitest';
import {
  createAgentExtensionRegistry,
  type ResolvedOrchestrationProfile,
  type SurfaceProfileEntry,
  type ToolMapGuardEntry,
} from './agentExtensions';

type Tools = Record<string, string>;
type State = { calls: string[] };

const logger = { info: vi.fn(), warn: vi.fn() };
const profileCtx = { executionId: 'exec-1', logger, contributedToolNames: ['alpha', 'beta'] };

function profile(id: string, surface: string): SurfaceProfileEntry {
  return {
    id,
    surface,
    build: ctx =>
      ({
        id,
        name: id,
        allowedTools: [...ctx.contributedToolNames],
        deniedTools: [],
        maxIterations: { quick: 1, medium: 2, very_thorough: 3 },
        defaultThoroughness: 'medium',
        isSynthetic: true,
      }) satisfies ResolvedOrchestrationProfile,
  };
}

function tagGuard(id: string, priority: number): ToolMapGuardEntry<Tools, State> {
  return {
    id,
    priority,
    apply: (tools, ctx) => {
      ctx.runState.calls.push(id);
      return Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, `${id}(${v})`]));
    },
  };
}

function newRegistry() {
  const warn = vi.fn();
  return { registry: createAgentExtensionRegistry<Tools, State>({ logger: { warn } }), warn };
}

describe('createAgentExtensionRegistry', () => {
  it('resolves a registered surface profile with the contributed tool names', () => {
    const { registry } = newRegistry();
    registry.registerSurfaceProfile(profile('synthetic:fixture', 'fixture-surface'), 'builtin');
    const resolved = registry.resolveSurfaceProfile('fixture-surface', profileCtx);
    expect(resolved?.id).toBe('synthetic:fixture');
    expect(resolved?.allowedTools).toEqual(['alpha', 'beta']);
  });

  it('returns undefined for an unknown or absent surface', () => {
    const { registry } = newRegistry();
    registry.registerSurfaceProfile(profile('synthetic:fixture', 'fixture-surface'), 'builtin');
    expect(registry.resolveSurfaceProfile('other', profileCtx)).toBeUndefined();
    expect(registry.resolveSurfaceProfile(undefined, profileCtx)).toBeUndefined();
    expect(registry.resolveSurfaceProfile(null, profileCtx)).toBeUndefined();
  });

  it('throws on a duplicate built-in profile or guard', () => {
    const { registry } = newRegistry();
    registry.registerSurfaceProfile(profile('a', 's'), 'builtin');
    expect(() => registry.registerSurfaceProfile(profile('b', 's'), 'builtin')).toThrow(/collides/);
    expect(() => registry.registerSurfaceProfile(profile('a', 's2'), 'builtin')).toThrow(/collides/);
    registry.registerToolMapGuard(tagGuard('g', 100), 'builtin');
    expect(() => registry.registerToolMapGuard(tagGuard('g', 200), 'builtin')).toThrow(/already registered/);
  });

  it('drops a colliding contribution with a warning and keeps the original', () => {
    const { registry, warn } = newRegistry();
    registry.registerSurfaceProfile(profile('builtin-profile', 's'), 'builtin');
    registry.registerToolMapGuard(tagGuard('g', 100), 'builtin');
    registry.registerContribution({
      surfaceProfiles: [profile('contributed-profile', 's')],
      toolMapGuards: [tagGuard('g', 5)],
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(registry.resolveSurfaceProfile('s', profileCtx)?.id).toBe('builtin-profile');
    expect(registry.list().toolMapGuards).toEqual([{ id: 'g', priority: 100, source: 'builtin' }]);
  });

  it('drops a contributed guard whose priority is outside 1-99', () => {
    const { registry, warn } = newRegistry();
    registry.registerContribution({ toolMapGuards: [tagGuard('low', 0), tagGuard('high', 100), tagGuard('ok', 99)] });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(registry.list().toolMapGuards.map(g => g.id)).toEqual(['ok']);
  });

  it('drops a malformed contribution without throwing', () => {
    const { registry, warn } = newRegistry();
    registry.registerContribution({
      surfaceProfiles: [{ id: 'x', surface: '' } as unknown as SurfaceProfileEntry],
      toolMapGuards: [{ id: 'y', priority: 1.5, apply: (t: Tools) => t }],
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(registry.list()).toEqual({ surfaceProfiles: [], toolMapGuards: [] });
  });

  it('drops a null contribution, null entries and non-array lists without throwing', () => {
    const { registry, warn } = newRegistry();
    registry.registerContribution(null as never);
    registry.registerContribution({ toolMapGuards: 'nope' as never });
    registry.registerContribution({ surfaceProfiles: [null as never], toolMapGuards: [undefined as never] });
    expect(warn).toHaveBeenCalledTimes(4);
    expect(registry.list()).toEqual({ surfaceProfiles: [], toolMapGuards: [] });
  });

  it('skips a contributed guard that throws or returns no map, and still runs the built-ins', () => {
    const { registry } = newRegistry();
    const runLogger = { info: vi.fn(), warn: vi.fn() };
    registry.registerToolMapGuard(tagGuard('inner', 100), 'builtin');
    registry.registerContribution({
      toolMapGuards: [
        {
          id: 'throws',
          priority: 1,
          apply: () => {
            throw new Error('boom');
          },
        },
        { id: 'empty', priority: 2, apply: () => undefined as unknown as Tools },
      ],
    });
    const out = registry.applyToolMapGuards(
      { t: 'x' },
      { executionId: 'e', logger: runLogger, runState: { calls: [] } }
    );
    expect(out.t).toBe('inner(x)');
    expect(runLogger.warn).toHaveBeenCalledTimes(2);
  });

  it('lets a throwing built-in guard propagate', () => {
    const { registry } = newRegistry();
    registry.registerToolMapGuard(
      {
        id: 'bad-builtin',
        priority: 100,
        apply: () => {
          throw new Error('host bug');
        },
      },
      'builtin'
    );
    expect(() => registry.applyToolMapGuards({}, { executionId: 'e', logger, runState: { calls: [] } })).toThrow(
      'host bug'
    );
  });

  it('resolves no profile when a contributed build throws', () => {
    const { registry } = newRegistry();
    const runLogger = { info: vi.fn(), warn: vi.fn() };
    registry.registerContribution({
      surfaceProfiles: [
        {
          id: 'p',
          surface: 's',
          build: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    expect(registry.resolveSurfaceProfile('s', { ...profileCtx, logger: runLogger })).toBeUndefined();
    expect(runLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('resolves no profile when a contributed build returns something that is not a profile', () => {
    const { registry } = newRegistry();
    const runLogger = { info: vi.fn(), warn: vi.fn() };
    registry.registerContribution({
      surfaceProfiles: [
        { id: 'p1', surface: 's1', build: () => ({}) as never },
        { id: 'p2', surface: 's2', build: () => true as never },
      ],
    });
    expect(registry.resolveSurfaceProfile('s1', { ...profileCtx, logger: runLogger })).toBeUndefined();
    expect(registry.resolveSurfaceProfile('s2', { ...profileCtx, logger: runLogger })).toBeUndefined();
    expect(runLogger.warn).toHaveBeenCalledTimes(2);
  });

  it('skips a contributed guard that returns a promise instead of a map', () => {
    const { registry } = newRegistry();
    const runLogger = { info: vi.fn(), warn: vi.fn() };
    registry.registerContribution({
      toolMapGuards: [{ id: 'async', priority: 1, apply: (async () => ({ t: 'y' })) as never }],
    });
    const out = registry.applyToolMapGuards(
      { t: 'x' },
      { executionId: 'e', logger: runLogger, runState: { calls: [] } }
    );
    expect(out).toEqual({ t: 'x' });
    expect(runLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('applies guards innermost-first by priority, ties broken by id, sharing one runState', () => {
    const { registry } = newRegistry();
    registry.registerToolMapGuard(tagGuard('outer', 300), 'builtin');
    registry.registerToolMapGuard(tagGuard('middle', 200), 'builtin');
    registry.registerToolMapGuard(tagGuard('inner', 100), 'builtin');
    registry.registerContribution({ toolMapGuards: [tagGuard('b-contrib', 50), tagGuard('a-contrib', 50)] });
    const runState: State = { calls: [] };
    const out = registry.applyToolMapGuards({ t: 'x' }, { executionId: 'e', logger, runState });
    expect(runState.calls).toEqual(['a-contrib', 'b-contrib', 'inner', 'middle', 'outer']);
    expect(out.t).toBe('outer(middle(inner(b-contrib(a-contrib(x)))))');
  });

  it('returns the input map unchanged when no guard is registered', () => {
    const { registry } = newRegistry();
    const tools = { t: 'x' };
    expect(registry.applyToolMapGuards(tools, { executionId: 'e', logger, runState: { calls: [] } })).toBe(tools);
  });

  it('refuses registration once frozen', () => {
    const { registry } = newRegistry();
    registry.freeze();
    expect(() => registry.registerSurfaceProfile(profile('a', 's'), 'builtin')).toThrow(/frozen/);
    expect(() => registry.registerContribution({ toolMapGuards: [tagGuard('g', 1)] })).toThrow(/frozen/);
  });
});
