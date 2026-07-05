import type { ChildExecution } from '@client/app/stores/useAgentExecutionStore';

/**
 * Merge REST-fallback child snapshots into the live child map for the
 * `reconnect_result` REST-fallback path.
 *
 * Per-child resolution prefers whichever side has *more iterations*:
 * - REST wins for terminal children whose persisted `result.steps` is the full
 *   trace (their live entry may be empty/partial after a mid-run reconnect).
 * - The live entry wins when it has at least as many iterations - in-flight
 *   in-process children whose checkpoint hasn't been written yet show empty
 *   REST steps, and wiping the live trace would lose user-visible context.
 *
 * Pure (no store access) so the prefer-more-iterations contract is unit-testable
 * - a regression inverting the comparison would otherwise pass silently.
 */
export function mergeChildExecutionsPreferringMoreIterations(
  existing: Record<string, ChildExecution>,
  replayed: Record<string, ChildExecution>
): Record<string, ChildExecution> {
  const merged: Record<string, ChildExecution> = { ...existing };
  for (const [id, restEntry] of Object.entries(replayed)) {
    const live = existing[id];
    if (!live || restEntry.iterations.length > live.iterations.length) {
      merged[id] = restEntry;
    }
  }
  return merged;
}
