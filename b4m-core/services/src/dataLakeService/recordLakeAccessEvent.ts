import type {
  IAdminSettingsRepository,
  ILakeAccessEventRepository,
  RecordLakeAccessEventInput,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { resolveLakeAuditRetention } from './resolveLakeAuditRetention';

/**
 * Best-effort write to the lake access audit trail. `record()` throws on failure (a bad enum, a
 * transient Mongo blip); this never rethrows, so a caller can safely `await` it without its own
 * response ever depending on the audit write succeeding - the returned promise always resolves.
 * `recorder` is optional because several call sites receive it as an optional DI adapter (see
 * ToolContext['db'].lakeAccessEvents); a host that never wired one in gets a silent no-op rather
 * than a crash.
 *
 * Whether to await: a serverless/per-request route handler should `await` this before responding
 * - once the response is sent, the runtime may freeze or recycle the execution environment before
 * an un-awaited write completes, silently dropping the audit row. A long-lived process turn (chat
 * tools, forced retrieval) should NOT await it - the write would add its own latency to a response
 * the model/user is actively waiting on, and the process outlives the request regardless.
 *
 * `adminSettings` is required, not optional, on purpose: `record()` defaults `retentionDays`/
 * `queryTextRetentionDays` to the platform FLOOR when neither is passed, and nothing was passing
 * them - every event was silently taking the floor regardless of what an operator configured.
 * Resolving it here, once, is what makes that impossible to forget at a tenth call site the way it
 * was forgotten at the first nine. `resolveLakeAuditRetention` itself never throws (falls back to
 * the floor on a settings-read failure), so this adds no new failure mode to the write.
 */
export function recordLakeAccessEvent(
  recorder: Pick<ILakeAccessEventRepository, 'record'> | undefined,
  input: RecordLakeAccessEventInput,
  logger: Pick<Logger, 'error' | 'warn'>,
  adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'>
): Promise<void> {
  if (!recorder) return Promise.resolve();
  const write = async () => {
    const retention = await resolveLakeAuditRetention({ adminSettings }, { logger: logger as Logger });
    await recorder.record({
      ...input,
      retentionDays: retention.auditRetentionDays,
      queryTextRetentionDays: retention.queryTextRetentionDays,
    });
  };
  return write().catch(err => {
    logger.error('[lakeAccessAudit] failed to record access event', err);
  });
}
