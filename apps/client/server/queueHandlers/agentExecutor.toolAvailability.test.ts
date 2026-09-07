/**
 * Key-availability filtering on the AGENT path, exercised through the REAL `buildSharedTools`
 * (via `toolBuilderDeps.fixture`) rather than a mock - a mocked builder can only prove the map
 * was passed, not that an unavailable tool actually fails to materialize.
 *
 * `processExecution` itself has no test harness (nothing in this directory drives it), so these
 * tests cover the seam the parent-toolbelt call site feeds: same builder, same option, same
 * enabledTools shape. The call sites' own wiring is guarded statically by
 * `packages/scripts/src/checkToolAvailabilityWired.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { buildSharedTools, type ToolAvailability } from '@bike4mind/services';
import { filterToolsByPatterns } from '@bike4mind/agents';
import { makeToolBuilderDeps, makeToolBuilderCallbacks } from './toolBuilderDeps.fixture';

const deps = makeToolBuilderDeps();
const callbacks = makeToolBuilderCallbacks();

// Typed as ToolAvailability, not Record<string, boolean>: a misspelled tool id would otherwise
// compile as a silent no-op and quietly make one of these tests vacuous.
const build = (enabledTools: string[], toolAvailability?: ToolAvailability) =>
  (buildSharedTools(deps, callbacks, { enabledTools, toolAvailability }) ?? []).map(t => t.toolSchema.name);

describe('agent toolbelt: key-gated availability filtering', () => {
  it('drops a key-gated tool with no working key and keeps an ungated one', () => {
    const names = build(['weather_info', 'dice_roll'], { weather_info: false });
    expect(names).not.toContain('weather_info');
    expect(names).toContain('dice_roll');
  });

  it('keeps a key-gated tool whose key resolves', () => {
    expect(build(['weather_info', 'dice_roll'], { weather_info: true })).toEqual(
      expect.arrayContaining(['weather_info', 'dice_roll'])
    );
  });

  it('offers every enabled tool when no availability map is passed', () => {
    // Pins the documented default: the option is optional and omitting it must not filter, which
    // is what kept these call sites behaving as before while only two of six were wired.
    expect(build(['weather_info', 'dice_roll'])).toEqual(expect.arrayContaining(['weather_info', 'dice_roll']));
  });

  it('still offers search_knowledge_base when its embedding key is missing', () => {
    // isToolOfferable's deliberate carve-out: KB degrades to keyword search, so hiding its schema
    // would be strictly worse than offering it. Not an oversight - see toolAvailability.ts.
    expect(build(['search_knowledge_base'], { search_knowledge_base: false })).toContain('search_knowledge_base');
  });
});

describe('agent toolbelt: availability composes with the subagent allowlist', () => {
  // SUBAGENT selection is the path that pattern-filters the LIST buildSharedTools returns
  // (selectSubagentTools -> filterToolsByPatterns, ServerSubagentOrchestrator.ts:364); the parent
  // toolbelt instead applies allowedTools to the names going IN. This pins the harder direction: a
  // pattern filter running AFTER the build cannot re-admit a tool availability already dropped.
  const allowedPatterns = ['weather_info', 'dice_roll'];

  it('an allowed but unavailable tool is absent from the effective toolset', () => {
    const built = buildSharedTools(deps, callbacks, {
      enabledTools: ['weather_info', 'dice_roll'],
      toolAvailability: { weather_info: false },
    })!;
    const effective = filterToolsByPatterns(built, allowedPatterns).map(t => t.toolSchema.name);
    expect(effective).not.toContain('weather_info');
    expect(effective).toContain('dice_roll');
  });

  it('an allowed and available tool survives both filters', () => {
    const built = buildSharedTools(deps, callbacks, {
      enabledTools: ['weather_info', 'dice_roll'],
      toolAvailability: { weather_info: true },
    })!;
    const effective = filterToolsByPatterns(built, allowedPatterns).map(t => t.toolSchema.name);
    expect(effective).toEqual(expect.arrayContaining(['weather_info', 'dice_roll']));
  });
});
