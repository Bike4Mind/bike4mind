import { describe, it, expect, vi } from 'vitest';
import { LATTICE_TOOL_NAMES } from '@bike4mind/services';
import { latticeToolDefinitions } from '@bike4mind/services/llm/tools/cliTools';

// Mock only `buildSharedTools` so the pool builder can be exercised without a
// full ToolBuilderDeps runtime; keep every other real export (LATTICE_TOOL_NAMES etc.).
const buildSharedToolsMock = vi.fn();
vi.mock('@bike4mind/services', async importActual => {
  const actual = await importActual<typeof import('@bike4mind/services')>();
  return { ...actual, buildSharedTools: (...args: unknown[]) => buildSharedToolsMock(...args) };
});

// Imported AFTER vi.mock so the SUT binds the mocked `buildSharedTools`.
const { resolveLatticeTools, buildSubagentLatticeToolPool } = await import('./agentExecutor.latticeTools');

const tool = (name: string) => ({ toolSchema: { name } });

describe('resolveLatticeTools', () => {
  it('disables Lattice and contributes nothing when neither source sets the flag', () => {
    const result = resolveLatticeTools({});
    expect(result.enableLattice).toBe(false);
    expect(result.latticeEnabledTools).toEqual([]);
    expect(result.latticeExternalTools).toEqual({});
  });

  it('enables Lattice from the start payload on a new execution', () => {
    const result = resolveLatticeTools({ startPayloadEnableLattice: true });
    expect(result.enableLattice).toBe(true);
    expect(result.latticeEnabledTools).toEqual(LATTICE_TOOL_NAMES);
    // Registering names without the backing definitions makes the tools a
    // silent no-op - the post-review wiring bug this test guards against.
    expect(result.latticeExternalTools).toBe(latticeToolDefinitions);
  });

  it('falls back to the persisted doc on continuations (start payload omits the flag)', () => {
    // The SQS continuation payload only carries executionId + connectionId, so
    // startPayloadEnableLattice is undefined here - without the doc fallback,
    // Lattice would silently vanish after the first handoff.
    const result = resolveLatticeTools({ executionEnableLattice: true });
    expect(result.enableLattice).toBe(true);
    expect(result.latticeEnabledTools).toEqual(LATTICE_TOOL_NAMES);
  });

  it('lets an explicit start-payload flag take precedence over the doc', () => {
    expect(resolveLatticeTools({ startPayloadEnableLattice: false, executionEnableLattice: true }).enableLattice).toBe(
      false
    );
    expect(resolveLatticeTools({ startPayloadEnableLattice: true, executionEnableLattice: false }).enableLattice).toBe(
      true
    );
  });
});

describe('buildSubagentLatticeToolPool', () => {
  // Cast covers the ToolBuilderDeps/Callbacks surface the mocked buildSharedTools ignores.
  const deps = {} as Parameters<typeof buildSubagentLatticeToolPool>[0];
  const callbacks = {} as Parameters<typeof buildSubagentLatticeToolPool>[1];

  it('requests the Lattice names + definitions from buildSharedTools', () => {
    buildSharedToolsMock.mockReturnValue(LATTICE_TOOL_NAMES.map(tool));
    buildSubagentLatticeToolPool(deps, callbacks, { deep_research: { model: 'x' } });
    expect(buildSharedToolsMock).toHaveBeenCalledWith(
      deps,
      callbacks,
      expect.objectContaining({
        enabledTools: [...LATTICE_TOOL_NAMES],
        externalTools: latticeToolDefinitions,
        config: { deep_research: { model: 'x' } },
      })
    );
  });

  it('keeps ONLY Lattice tools, dropping delegate/coordinate that buildSharedTools injects', () => {
    // The pool builder clears agentStore to avoid delegate/coordinate injection,
    // but this filter still defensively drops them if they ever reach the pool.
    buildSharedToolsMock.mockReturnValue([
      ...LATTICE_TOOL_NAMES.map(tool),
      tool('delegate_to_agent'),
      tool('coordinate_task'),
    ]);
    const pool = buildSubagentLatticeToolPool(deps, callbacks, undefined);
    expect(pool.map(t => t.toolSchema.name)).toEqual([...LATTICE_TOOL_NAMES]);
  });

  it('returns [] when buildSharedTools yields nothing', () => {
    buildSharedToolsMock.mockReturnValue(undefined);
    expect(buildSubagentLatticeToolPool(deps, callbacks, undefined)).toEqual([]);
  });
});
