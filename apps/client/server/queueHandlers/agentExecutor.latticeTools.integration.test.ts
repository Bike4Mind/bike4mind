import { describe, it, expect } from 'vitest';
import { LATTICE_TOOL_NAMES } from '@bike4mind/services';
import { buildSubagentLatticeToolPool } from './agentExecutor.latticeTools';
import { makeToolBuilderDeps, makeToolBuilderCallbacks } from './toolBuilderDeps.fixture';

/**
 * End-to-end guard for issue #214.
 *
 * The sibling `agentExecutor.latticeTools.test.ts` mocks `buildSharedTools`, so
 * it only proves the RIGHT ARGUMENTS are passed - not that real deps actually
 * resolve `lattice_*` tools out the other end. This is the exact class of
 * silent no-op the feature already hit once (a missing backing adapter made the
 * whole path resolve to nothing until the post-review wiring fix).
 *
 * This test deliberately does NOT mock `buildSharedTools`: it runs the real
 * resolution pipeline (`generateTools` -> `latticeToolDefinitions` merged into
 * `externalTools`, filtered by `LATTICE_TOOL_NAMES`) against a real - if lightly
 * stubbed - `ToolBuilderDeps`, and asserts the pool contains the Lattice tools
 * by name. A future `buildSharedTools` refactor that stops mapping
 * `enabledTools`/`externalTools` -> tools would make this go red instead of
 * silently returning `[]`.
 */
describe('buildSubagentLatticeToolPool (integration, real buildSharedTools)', () => {
  const pool = buildSubagentLatticeToolPool(makeToolBuilderDeps(), makeToolBuilderCallbacks(), undefined);

  it('resolves EXACTLY the lattice_* tools from real ToolBuilderDeps', () => {
    // Exact set-equality proves both halves of the contract at once: every
    // lattice name resolves (no silent-drop no-op) AND nothing else leaks in
    // (the agentStore short-circuit keeps delegate_to_agent / coordinate_task
    // out). A buildSharedTools refactor that stops mapping enabledTools /
    // externalTools -> tools turns this red instead of returning [].
    expect(pool.map(tool => tool.toolSchema.name).sort()).toEqual([...LATTICE_TOOL_NAMES].sort());
  });

  it('backs every resolved name with a callable toolFn', () => {
    // The one signal set-equality can't give: a name present but unbacked would
    // be a silent no-op at execution time. buildSharedTools drops unbacked
    // names, so each entry that survives must be a real, callable tool.
    expect(pool.every(tool => typeof tool.toolFn === 'function')).toBe(true);
  });
});
