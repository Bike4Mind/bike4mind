import { Resource } from 'sst';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { categorizeToolError } from '@bike4mind/services';
import { emitMetrics } from '@server/utils/cloudwatch';

/**
 * Namespace for quest-lifecycle operational metrics; must match the timeout sweep's
 * (apps/workers/src/cron/questTimeoutSweep.ts). Keep the `ProcessingFailed` metric name and its
 * `Stage` dimension in sync with infra/alarms.ts.
 */
export const QUESTS_CLOUDWATCH_NAMESPACE = 'Lumina5/Quests';

/** Completion entry point a failure came from: internal `/process`, the CLI SSE/WS routes, or embed chat. */
export type ProcessingFailureSurface = '/process' | 'cli-sse' | 'cli-ws' | 'embed';

/**
 * Count one completion failure on the operator-facing `ProcessingFailed` metric. Never rejects and
 * never throws, so a call site can fire it from a catch without masking the original error.
 *
 * Three datums, same metric name: CloudWatch keys a custom metric by namespace + name + the EXACT
 * dimension set and never rolls one up into another, so each is its own series and none
 * double-counts. The Stage-only point is the one the infra/alarms.ts alarm watches (a finer
 * dimension set would leave it permanently INSUFFICIENT_DATA); Stage+ErrorClass and Stage+Surface
 * are the dashboard breakdowns. ErrorClass reuses the tool-call telemetry taxonomy
 * (categorizeToolError), which has no credential rule, so a credential failure scatters by wording
 * across internal_error / auth_error / validation_error.
 */
export async function emitProcessingFailed(surface: ProcessingFailureSurface, error: unknown): Promise<void> {
  try {
    const stage = Resource.App.stage;
    const errorClass = categorizeToolError(error instanceof Error ? error.message : String(error));
    const datum = (dimensions: Record<string, string>) => ({
      name: 'ProcessingFailed',
      value: 1,
      dimensions,
      unit: StandardUnit.Count,
    });
    await emitMetrics(QUESTS_CLOUDWATCH_NAMESPACE, [
      datum({ Stage: stage }),
      datum({ Stage: stage, ErrorClass: errorClass }),
      datum({ Stage: stage, Surface: surface }),
    ]);
  } catch (metricErr) {
    console.error('[ProcessingFailed] Failed to emit metric', metricErr);
  }
}
