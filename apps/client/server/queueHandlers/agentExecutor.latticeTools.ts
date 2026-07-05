/**
 * Resolves the `enableLattice` launch-gate flag and returns the Lattice
 * tool contribution merged into `buildSharedTools()`.
 *
 * The flag must be re-resolved on every Lambda invocation: the SQS continuation
 * payload only carries `executionId` + `connectionId`, so on a handoff
 * `startPayload.enableLattice` is undefined and the value must fall back to the
 * persisted execution doc. Reading from `startPayload` alone would make Lattice
 * silently vanish after the first iteration.
 *
 * Unlike `b4mTools`, Lattice definitions aren't in the default resolvable map,
 * so `latticeToolDefinitions` must also be merged into `externalTools` - the
 * names alone (`LATTICE_TOOL_NAMES`) would be silently dropped by
 * `buildSharedTools`.
 *
 * Extracted as a pure helper so the resolution + contribution shape is
 * unit-testable - it previously lived inline in `processExecution` with zero
 * coverage, and a missing backing adapter (`latticeModelRepository`) made the
 * whole path a silent no-op until the post-review wiring fix. A test that pins
 * this contribution catches a future refactor that forgets the continuation
 * fallback or the `externalTools` merge.
 */
import { LATTICE_TOOL_NAMES } from '@bike4mind/services';
import { latticeToolDefinitions } from '@bike4mind/services/llm/tools/cliTools';

export interface ResolveLatticeToolsInput {
  /** `enableLattice` from the WS start payload (present only on new executions). */
  startPayloadEnableLattice?: boolean;
  /** `enableLattice` persisted on the execution doc (the continuation fallback). */
  executionEnableLattice?: boolean;
}

export interface LatticeToolContribution {
  enableLattice: boolean;
  latticeEnabledTools: readonly (typeof LATTICE_TOOL_NAMES)[number][];
  latticeExternalTools: Partial<typeof latticeToolDefinitions>;
}

export function resolveLatticeTools({
  startPayloadEnableLattice,
  executionEnableLattice,
}: ResolveLatticeToolsInput): LatticeToolContribution {
  const enableLattice = startPayloadEnableLattice ?? executionEnableLattice ?? false;
  return {
    enableLattice,
    latticeEnabledTools: enableLattice ? LATTICE_TOOL_NAMES : [],
    latticeExternalTools: enableLattice ? latticeToolDefinitions : {},
  };
}
