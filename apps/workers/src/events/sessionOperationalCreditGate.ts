import type { ModelInfo } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { checkSessionOperationalCredits } from '@server/utils/sessionOperationalCreditPreflight';

/**
 * Balance gate for the session event handlers (auto-naming, summarization, tagging, context
 * summarization, mementos), run right before their model call.
 *
 * Most of these events are published downstream of a chat turn, and that turn's settlement can
 * leave the payer at exactly zero (the balance cap floors it there). `recordOperationalUsage`
 * floors the follow-up charge at zero, so without this gate the work would still run and its cost
 * would be written off. The request-side pre-flight
 * (`apps/client/server/utils/sessionOperationalCreditPreflight`) only guards the routes that
 * publish these events directly; this covers every publisher, including future ones.
 *
 * Pass `resolveModelInfo` when the call does not run on the operations model, so a free model
 * waives the refusal. Returns false to skip the work. An unexpected failure also skips: the work
 * is a non-critical convenience, and skipping it cannot cost the payer anything.
 */
export async function payerCanFundSessionOperation({
  payerId,
  operation,
  resolveModelInfo,
  logger,
}: {
  payerId: string;
  operation: string;
  resolveModelInfo?: () => Promise<ModelInfo>;
  logger: Logger;
}): Promise<boolean> {
  try {
    const verdict = await checkSessionOperationalCredits({
      userId: payerId,
      operationCount: 1,
      operation,
      resolveModelInfo,
      logger,
    });
    if (verdict.allowed) return true;
    logger.info(`[SESSION_OP_CREDIT_SKIP] skipping ${operation}; payer cannot cover it`, {
      payerId,
      reason: verdict.reason,
    });
    return false;
  } catch (err) {
    logger.error(`[SESSION_OP_CREDIT_SKIP] credit check failed; skipping ${operation}`, err, { payerId });
    return false;
  }
}
