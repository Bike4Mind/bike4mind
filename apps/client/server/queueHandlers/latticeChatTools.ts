/**
 * Merges the Lattice tool definitions into a web chat handler's `externalTools`
 * map when `enableLattice` is set.
 *
 * Lattice tool *names* (`LATTICE_TOOL_NAMES`) are appended to `enabledTools`
 * inside `ChatCompletionProcess` when the flag is set, but their
 * *implementations* are CLI-isolated (`latticeToolDefinitions` in `cliTools`)
 * and intentionally absent from the default `b4mTools` map. The names only
 * resolve if the definitions ride along as `externalTools` - otherwise they're
 * silently dropped as "undefined tools". Mirrors the agent_executor wiring.
 *
 * Extracted as a pure helper so both web chat handlers (`questProcessor` and
 * `slackQuestProcessor`) share one contribution shape and the no-op contract is
 * unit-testable. A no-op when the flag is unset - the existing base tools
 * (Slack / pending-action) are returned untouched. On collision, Lattice
 * definitions win (merged last), matching the prior inline behavior.
 */
import type { ToolDefinition } from '@bike4mind/services/llm/tools';
import { latticeToolDefinitions } from '@bike4mind/services/llm/tools/cliTools';

export function withLatticeTools(
  externalTools: Record<string, ToolDefinition> | undefined,
  enableLattice: boolean | undefined
): Record<string, ToolDefinition> | undefined {
  if (!enableLattice) return externalTools;
  return { ...externalTools, ...latticeToolDefinitions };
}
