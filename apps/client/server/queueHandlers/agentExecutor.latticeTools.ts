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
import {
  LATTICE_TOOL_NAMES,
  buildSharedTools,
  type BuildSharedToolsOptions,
  type ToolBuilderDeps,
  type ToolBuilderCallbacks,
} from '@bike4mind/services';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
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

/**
 * Builds the Lattice tool pool a subagent can OPT INTO via `allowedTools`.
 *
 * Unlike `resolveLatticeTools` (which gates the PARENT's Lattice toolbelt on the
 * `enableLattice` launch flag), this builds the Lattice tools UNCONDITIONALLY.
 * The result is handed to `ServerSubagentOrchestrator`'s `optInTools`, which
 * grants them only to subagents whose `allowedTools` explicitly name `lattice_*`
 * — so a delegated agent can use Lattice even when the parent run didn't enable
 * it, without Lattice ever being forced onto every delegated run.
 *
 * `deps.db.latticeModels` MUST be wired or created models won't persist across
 * calls (the create→populate→query chain silently breaks — the same adapter the
 * top-level path wires for its own Lattice tools). Returns `[]` if the tool
 * builder yields nothing (defensive; `buildSharedTools` returns `undefined` when
 * no tools resolve).
 *
 * Built eagerly once per execution even when no subagent ends up opting in. That
 * is intentional and cheap: clearing `agentStore` (below) short-circuits before
 * the subagent-LLM build and the delegate/coordinate injection, so this resolves
 * only the Lattice native tools + `externalTools` merge - synchronous, no I/O. If
 * this ever grows expensive, make it lazy (build on first delegation) instead.
 */
export function buildSubagentLatticeToolPool(
  deps: ToolBuilderDeps,
  callbacks: ToolBuilderCallbacks,
  config: BuildSharedToolsOptions['config']
): ICompletionOptionTools[] {
  // Clear `agentStore` so `buildSharedTools` short-circuits *before* its subagent
  // injection branch. With an `agentStore` present it would build a subagent LLM
  // plus full `delegate_to_agent` / `coordinate_task` instances — all thrown away
  // by the name filter below. The Lattice tools resolve purely from the
  // `enabledTools` / `externalTools` merge, which never touches `agentStore`.
  // Also drop `onToolLlmUsage`: this pool is billed by the parent iteration, and no
  // Lattice tool self-bills today, but stripping it keeps nested spend from ever
  // folding into the parent's charge twice (defense-in-depth).
  const built =
    buildSharedTools({ ...deps, agentStore: undefined, onToolLlmUsage: undefined }, callbacks, {
      enabledTools: [...LATTICE_TOOL_NAMES],
      externalTools: latticeToolDefinitions,
      config,
    }) ?? [];
  // Defensive: the opt-in pool must contain ONLY the Lattice tools. The
  // `agentStore` short-circuit above already prevents delegate/coordinate
  // injection, so this filter is now a guard against a future path that resolves
  // extra tools before the short-circuit.
  const latticeNames = new Set<string>(LATTICE_TOOL_NAMES);
  return built.filter(tool => latticeNames.has(tool.toolSchema.name));
}
