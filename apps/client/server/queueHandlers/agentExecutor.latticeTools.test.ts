import { describe, it, expect } from 'vitest';
import { LATTICE_TOOL_NAMES } from '@bike4mind/services';
import { latticeToolDefinitions } from '@bike4mind/services/llm/tools/cliTools';
import { resolveLatticeTools } from './agentExecutor.latticeTools';

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
