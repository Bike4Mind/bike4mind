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
 * Whether to await: a per-request API route should `await` this before responding - once the
 * response is sent, the runtime may freeze or recycle the execution environment before an
 * un-awaited write completes, silently dropping the audit row. The chat-tool / forced-retrieval
 * call sites do NOT await it, for a narrower reason than "no freeze risk": `agentExecutor` and
 * `slackQuestProcessor` are genuine `sst.aws.Function` Lambdas, so the same freeze risk exists
 * there in principle (`questProcessor` is not - it moved to an always-on Fargate worker, see
 * `apps/client/server/chatCompletion/server.ts`). Where the risk is real, several more seconds of
 * LLM work (completion, streaming) follow the tool call before that Lambda invocation can return,
 * so in practice the write has already landed well before any freeze - awaiting there would only
 * add this write's own latency to a response the model/user is actively waiting on, for a risk
 * window that in practice does not occur on this path today. Revisit if that call shape ever
 * changes (e.g. a tool call becomes the last thing an invocation does) - `knowledgeBaseRetrieve`'s
 * Path A already widened this once: its attribution now resolves dynamic lake access in this same
 * un-awaited tail too, not just the write, since that lookup used to block the tool's own return.
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
    // The cast is required, not just convenient: this function only needs error/warn, but
    // resolveLakeAuditRetention forwards `logger` on into getSettingsByNames's cache layer,
    // which constructs `logger || new Logger()` and genuinely needs the full Logger shape - so
    // resolveLakeAuditRetention's own param can't be narrowed to match this function's signature
    // without breaking that chain.
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
