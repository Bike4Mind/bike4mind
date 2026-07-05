/**
 * Returns true when the given stage should have monitoring enabled.
 *
 * - If `monitoredStages` is undefined or empty, returns false unless `envOverride === 'true'`.
 * - `envOverride` is additive: a stage already in `monitoredStages` returns true regardless.
 */
export function isMonitoredStage(
  stage: string,
  monitoredStages: readonly string[] | undefined,
  envOverride?: string
): boolean {
  if (envOverride === 'true') return true;
  if (!monitoredStages || monitoredStages.length === 0) return false;
  return monitoredStages.includes(stage);
}
