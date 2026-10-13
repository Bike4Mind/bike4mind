import { Resource } from 'sst';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { QUESTS_NAMESPACE, QUEST_METRICS } from '@bike4mind/infra';
import { categorizeToolError } from '@bike4mind/services';
import { isOperatorFault } from '@bike4mind/services/llm';
import { emitMetrics } from '@server/utils/cloudwatch';

/** Completion entry point a failure came from: internal `/process`, the CLI SSE/WS routes, or embed chat. */
export type ProcessingFailureSurface = '/process' | 'cli-sse' | 'cli-ws' | 'embed';

/**
 * Count one completion failure on the operator-facing `ProcessingFailed` metric. Never rejects and
 * never throws, so a call site can fire it from a catch without masking the original error.
 *
 * Non-/process surfaces count only operator faults (isOperatorFault), so billing rejections, aborts,
 * caller-input errors and the handled terminal cases /process never sees stay out of the metric.
 *
 * Same metric name, one datum per dimension set: CloudWatch keys a custom metric by namespace + name
 * + the EXACT dimension set and never rolls one up into another, so each is its own series and none
 * double-counts. Every surface emits Stage+Surface; the one with Surface '/process' is what the
 * infra/alarms.ts alarm watches (alarms match one exact dimension set). Only /process also emits the
 * legacy Stage and Stage+ErrorClass series, so the existing /process breakdown stays /process-only.
 * ErrorClass reuses the tool-call telemetry taxonomy (categorizeToolError), which has no credential
 * rule, so a credential failure scatters by wording across internal_error / auth_error / validation_error.
 */
export async function emitProcessingFailed(surface: ProcessingFailureSurface, error: unknown): Promise<void> {
  try {
    if (surface !== '/process' && !isOperatorFault(error)) return;
    const stage = Resource.App.stage;
    const datum = (dimensions: Record<string, string>) => ({
      name: QUEST_METRICS.ProcessingFailed,
      value: 1,
      dimensions,
      unit: StandardUnit.Count,
    });
    const surfaceDatum = datum({ Stage: stage, Surface: surface });
    if (surface !== '/process') {
      await emitMetrics(QUESTS_NAMESPACE, [surfaceDatum]);
      return;
    }
    const errorClass = categorizeToolError(error instanceof Error ? error.message : String(error));
    await emitMetrics(QUESTS_NAMESPACE, [
      datum({ Stage: stage }),
      datum({ Stage: stage, ErrorClass: errorClass }),
      surfaceDatum,
    ]);
  } catch (metricErr) {
    console.error('[ProcessingFailed] Failed to emit metric', metricErr);
  }
}
