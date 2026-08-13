import type { ILakeAccessEventRepository, RecordLakeAccessEventInput } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/**
 * Fire-and-forget write to the lake access audit trail (#1678). `record()` throws on failure (a
 * bad enum, a transient Mongo blip) - never await this from a caller whose own response must not
 * depend on the audit write succeeding. `recorder` is optional because several call sites receive
 * it as an optional DI adapter (see ToolContext['db'].lakeAccessEvents); a host that never wired
 * one in gets a silent no-op rather than a crash.
 */
export function recordLakeAccessEvent(
  recorder: Pick<ILakeAccessEventRepository, 'record'> | undefined,
  input: RecordLakeAccessEventInput,
  logger: Pick<Logger, 'error'>
): void {
  if (!recorder) return;
  recorder.record(input).catch(err => {
    logger.error('[lakeAccessAudit] failed to record access event', err);
  });
}
