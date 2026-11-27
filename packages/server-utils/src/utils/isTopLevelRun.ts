/** A run with no parent, spawner or DAG node: the only kind that owns a live activity, a terminal push or an event brief. */
export function isTopLevelRun(execution: {
  parentExecutionId?: unknown;
  spawnedByExecutionId?: unknown;
  dagNodeId?: string;
}): boolean {
  return !execution.parentExecutionId && !execution.spawnedByExecutionId && !execution.dagNodeId;
}
